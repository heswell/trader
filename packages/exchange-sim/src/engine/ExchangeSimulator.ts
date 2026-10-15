import {
  OrderType as BookOrderType,
  TimeInForce as BookTif,
  type Trade,
} from "@heswell/hft-limit-order-book";
import {
  BotType,
  ExecType,
  OrdType,
  RejectReason,
  roundToLot,
  TradingPhase,
} from "@heswell/trading-schemas";
import {
  DEFAULT_CONFIG,
  type ExchangeSimConfig,
  validateConfig,
} from "../config";
import {
  GATEWAY_OWNER,
  SimExchangeGateway,
} from "../gateway/SimExchangeGateway";
import type { ExecutionReport } from "../gateway/types";
import {
  type ExchangeTables,
  MarketDataPublisher,
  type TapeTrade,
} from "../publish/MarketDataPublisher";
import {
  ALL_INSTRUMENTS,
  type InstrumentDef,
  selectActiveInstruments,
} from "../reference/instruments";
import { type Clock, systemClock } from "../util/clock";
import { Random } from "../util/random";
import { MarketMaker } from "./bots/MarketMaker";
import { NoiseTaker } from "./bots/NoiseTaker";
import { fromBookSide, InstrumentBook, toBookSide } from "./InstrumentBook";
import {
  type BookSettings,
  type ExchangeJournal,
  type ExchangeJournalEntry,
  type ExchangeRestoreResult,
  type ExchangeState,
  type ILimitOrder,
  TRADE_ID_BLOCK,
} from "./persistence";
import { type SessionPhase, TradingSession } from "./TradingSession";

export interface SimulatedInstrument {
  readonly book: InstrumentBook;
  readonly marketMakers: readonly MarketMaker[];
  readonly taker: NoiseTaker;
  readonly modelRng: Random;
  /** MARKET_MAKER discretionary churn, events/s for the instrument (0 = paused). */
  mmRate: number;
  /** TAKER orders/s for the instrument (0 = paused). */
  takerRate: number;
}

export interface ExchangeSimulatorOptions {
  config?: Partial<ExchangeSimConfig>;
  clock?: Clock;
  /** Listed instruments (default: the bundled universe). */
  universe?: readonly InstrumentDef[];
}

/** Admin request failure, mapped to an RPC ERROR_RESULT by the admin service. */
export class ExchangeAdminError extends Error {
  constructor(
    readonly reason: RejectReason,
    text: string,
  ) {
    super(text);
  }
}

export type TapeListener = (trade: TapeTrade) => void;

export interface SessionStatus {
  /** Current market-wide phase (halted books keep HALTED on top of this). */
  phase: SessionPhase;
  /** Phase after the next scheduled change (undefined = no change scheduled). */
  nextPhase?: SessionPhase;
  /** Clock time of the next scheduled change. */
  nextChangeAt?: number;
  /** True while a setMarketPhase override is in force. */
  forced: boolean;
}

/**
 * The exchange: one InstrumentBook per active instrument, the bots that
 * trade on them, the OMS gateway and (once tables are attached) the market
 * data publisher. Time only advances through `step(now)` / `flush(now)`,
 * driven either by `start()` timers or directly by tests and benchmarks.
 */
export class ExchangeSimulator {
  readonly config: ExchangeSimConfig;
  readonly clock: Clock;
  readonly universe: readonly InstrumentDef[];
  readonly gateway: SimExchangeGateway;
  readonly session: TradingSession;
  readonly #listed = new Map<string, InstrumentDef>();
  readonly #simulated = new Map<string, SimulatedInstrument>();
  readonly #books: InstrumentBook[] = [];
  readonly #tapeListeners = new Set<TapeListener>();
  #publisher: MarketDataPublisher | undefined;
  #lastStep: number | undefined;
  #cursor = 0;
  #tradeSeq = 0;
  #stepTimer: ReturnType<typeof setInterval> | undefined;
  #flushTimer: ReturnType<typeof setInterval> | undefined;
  #marketPhase: SessionPhase = TradingPhase.Continuous;
  /** setMarketPhase override, in force until `until` (undefined = indefinitely). */
  #forced: { phase: SessionPhase; until: number | undefined } | undefined;
  /** Book events deferred because a step hit maxOpsPerStep. */
  deferredSteps = 0;
  #journal: ExchangeJournal | undefined;
  /** Trade ids up to this value are journaled as reserved. */
  #tradeReserved = 0;

  constructor({
    config = {},
    clock = systemClock,
    universe = ALL_INSTRUMENTS,
  }: ExchangeSimulatorOptions = {}) {
    this.config = validateConfig({ ...DEFAULT_CONFIG, ...config });
    this.clock = clock;
    this.universe = universe;
    for (const instrument of universe)
      this.#listed.set(instrument.ric, instrument);

    const rics = this.config.instruments
      .split(",")
      .map((ric) => ric.trim())
      .filter(Boolean);
    const active = selectActiveInstruments(
      universe,
      this.config.activeInstruments,
      rics,
    );
    const rng = new Random(this.config.seed);
    for (const [i, instrument] of active.entries()) {
      this.#addInstrument(instrument, rng.fork(i));
    }
    this.gateway = new SimExchangeGateway({
      clock,
      getInstrument: (ric) => this.#listed.get(ric),
      getBook: (ric) => this.#simulated.get(ric)?.book,
    });
    this.session = new TradingSession(this.config);
    this.updateSession(clock());
  }

  #addInstrument(instrument: InstrumentDef, rng: Random) {
    const { config } = this;
    const volatility =
      config.defaultVolatility > 0
        ? config.defaultVolatility
        : rng.uniform(0.2, 0.5);
    const book = new InstrumentBook(
      instrument,
      volatility,
      config.priceBandPct,
      this.clock,
      (b, trade) => this.#onTrade(b, trade),
    );
    const { refPrice, lotSize, tickSize, usdPerPriceUnit } = instrument;
    const baseQty = Math.max(
      lotSize,
      roundToLot(
        config.baseNotionalUsd / (refPrice * usdPerPriceUnit),
        lotSize,
      ),
    );
    const tickBps = (tickSize / refPrice) * 1e4;
    const ticksFor = (bps: number) => Math.max(1, Math.round(bps / tickBps));
    const marketMakers = Array.from(
      { length: config.mmPerInstrument },
      (_, i) =>
        new MarketMaker(
          {
            account: `MM${i + 1}`,
            levels: config.mmLevels,
            halfSpreadTicks: ticksFor(rng.uniform(2, 6)),
            spacingTicks: ticksFor(rng.uniform(1, 3)),
            baseQty,
          },
          book,
          rng.fork(100 + i),
        ),
    );
    const taker = new NoiseTaker(
      {
        accounts: ["TAKER1", "TAKER2", "TAKER3"],
        baseQty: Math.max(lotSize, roundToLot(baseQty * 0.6, lotSize)),
        passiveLifetimeMs: 2_000,
      },
      book,
      rng.fork(200),
    );
    this.#simulated.set(instrument.ric, {
      book,
      marketMakers,
      taker,
      modelRng: rng.fork(300),
      mmRate: config.mmRate,
      takerRate: config.takerRate,
    });
    this.#books.push(book);
  }

  get books(): readonly InstrumentBook[] {
    return this.#books;
  }

  get publisher() {
    return this.#publisher;
  }

  get running() {
    return this.#stepTimer !== undefined;
  }

  getInstrument(ric: string) {
    return this.#listed.get(ric);
  }

  getSimulated(ric: string) {
    return this.#simulated.get(ric);
  }

  getBook(ric: string) {
    return this.#simulated.get(ric)?.book;
  }

  isSimulated = (ric: string) => this.#simulated.has(ric);

  /** Total book operations + trades across all books. */
  get bookEvents() {
    let total = 0;
    for (const book of this.#books) total += book.events;
    return total;
  }

  get tradeCount() {
    return this.#tradeSeq;
  }

  /** Subscribe to the public tape (every trade, in execution order). */
  onTape(listener: TapeListener) {
    this.#tapeListeners.add(listener);
    return () => {
      this.#tapeListeners.delete(listener);
    };
  }

  #onTrade(book: InstrumentBook, trade: Trade) {
    if (this.#journal && this.#tradeSeq >= this.#tradeReserved) {
      this.#tradeReserved = this.#tradeSeq + TRADE_ID_BLOCK;
      this.#journal({ k: "tradeSeq", upTo: this.#tradeReserved });
    }
    const tradeId = `TR${String(++this.#tradeSeq).padStart(9, "0")}`;
    if (this.#publisher || this.#tapeListeners.size > 0) {
      const tape: TapeTrade = {
        tradeId,
        ric: book.ric,
        price: trade.price,
        size: trade.size,
        aggressorSide: fromBookSide(trade.side),
        timestamp: trade.timestamp,
        seq: trade.seq,
      };
      this.#publisher?.addTrade(tape);
      for (const listener of this.#tapeListeners) listener(tape);
    }
    return tradeId;
  }

  // ---------------------------------------------------------------- tables

  /** Bind the Vuu tables, load static rows and publish the initial state. */
  attachTables(tables: ExchangeTables) {
    if (this.#publisher)
      throw Error("ExchangeSimulator: tables already attached");
    const publisher = new MarketDataPublisher(
      tables,
      this.config.depthLevels,
      this.config.tradesCapacity,
    );
    publisher.loadInstruments(this.universe, this.isSimulated);
    this.#publisher = publisher;
    this.flush();
    return publisher;
  }

  // ---------------------------------------------------------------- session

  /** Market-wide phase from the session schedule (or setMarketPhase). */
  get marketPhase(): SessionPhase {
    return this.#marketPhase;
  }

  sessionStatus(now = this.clock()): SessionStatus {
    const forced = this.#forced;
    const nextChangeAt = forced ? forced.until : this.session.nextChangeAt(now);
    return {
      phase: this.#marketPhase,
      nextPhase:
        nextChangeAt === undefined
          ? undefined
          : this.session.phaseAt(nextChangeAt),
      nextChangeAt,
      forced: forced !== undefined,
    };
  }

  /**
   * Apply the session schedule at `now` (called by step()). Returns the
   * market phase.
   */
  updateSession(now = this.clock()) {
    const forced = this.#forced;
    let changed = false;
    if (forced && forced.until !== undefined && now >= forced.until) {
      this.#forced = undefined;
      changed = true;
    }
    const phase = this.#forced?.phase ?? this.session.phaseAt(now);
    if (phase !== this.#marketPhase) {
      this.#applyMarketPhase(phase);
      changed = true;
    }
    if (changed) this.#journalSession();
    return phase;
  }

  /**
   * Force the market-wide phase now, until the next scheduled phase change
   * (indefinitely when there is no schedule). CLOSED expires DAY orders.
   */
  setMarketPhase(phase: SessionPhase, now = this.clock()): string[] {
    this.#forced = { phase, until: this.session.nextChangeAt(now) };
    this.updateSession(now);
    this.#journalSession();
    return this.#books.map((book) => book.ric);
  }

  #applyMarketPhase(phase: SessionPhase) {
    this.#marketPhase = phase;
    for (const book of this.#books) {
      if (book.phase === TradingPhase.Halted) continue;
      book.phase = phase;
      book.dirty = true;
    }
    if (phase === TradingPhase.Closed) {
      for (const sim of this.#simulated.values()) {
        for (const mm of sim.marketMakers) mm.pull();
        sim.taker.pull();
      }
      this.gateway.expireDayOrders();
    }
  }

  // ---------------------------------------------------------------- time

  /** Advance the session, prices and bots to `now`. */
  step(now = this.clock()) {
    const { config } = this;
    this.updateSession(now);
    const elapsed =
      this.#lastStep === undefined ? config.botStepMs : now - this.#lastStep;
    this.#lastStep = now;
    const dt = Math.min(Math.max(elapsed, 0), config.maxStepMs) / 1000;
    if (dt === 0) return;
    const modelDt = dt * config.timeScale;
    const books = this.#books;
    const count = books.length;
    let ops = 0;
    for (let n = 0; n < count; n++) {
      if (ops >= config.maxOpsPerStep) {
        this.deferredSteps++;
        break;
      }
      const i = (this.#cursor + n) % count;
      const book = books[i];
      if (book.phase !== TradingPhase.Continuous) continue;
      const sim = this.#simulated.get(book.ric) as SimulatedInstrument;
      const before = book.events;
      book.model.step(modelDt, sim.modelRng);
      if (sim.mmRate > 0) {
        const perMm = sim.mmRate / sim.marketMakers.length;
        for (const mm of sim.marketMakers) mm.step(dt, perMm);
      }
      if (sim.takerRate > 0) sim.taker.step(dt, sim.takerRate, now);
      ops += book.events - before;
    }
    this.#cursor = (this.#cursor + 1) % Math.max(count, 1);
  }

  /** Publish dirty books and pending trades. */
  flush(now = this.clock()) {
    this.#publisher?.flush(this.#books, now);
  }

  start() {
    if (this.#stepTimer) return;
    const { botStepMs, publishIntervalMs } = this.config;
    this.#lastStep = this.clock();
    this.#stepTimer = setInterval(() => this.step(), botStepMs);
    this.#flushTimer = setInterval(() => this.flush(), publishIntervalMs);
  }

  stop() {
    clearInterval(this.#stepTimer);
    clearInterval(this.#flushTimer);
    this.#stepTimer = undefined;
    this.#flushTimer = undefined;
  }

  // ---------------------------------------------------------------- admin

  #target(ric: string | undefined): SimulatedInstrument[] {
    if (ric === undefined || ric === "") return [...this.#simulated.values()];
    const sim = this.#simulated.get(ric);
    if (!sim) {
      throw new ExchangeAdminError(
        RejectReason.UnknownInstrument,
        this.#listed.has(ric)
          ? `${ric} is not simulated`
          : `unknown instrument ${ric}`,
      );
    }
    return [sim];
  }

  setVolatility(ric: string | undefined, volatility: number): string[] {
    const targets = this.#target(ric);
    for (const { book } of targets) book.model.volatility = volatility;
    this.#journalBooks(targets);
    return targets.map(({ book }) => book.ric);
  }

  haltInstrument(ric: string, reason = ""): string[] {
    const [{ book }] = this.#target(ric);
    book.phase = TradingPhase.Halted;
    book.haltReason = reason;
    book.dirty = true;
    this.#journalBooks(this.#target(ric));
    return [book.ric];
  }

  resumeInstrument(ric: string, auction = false): string[] {
    const [{ book }] = this.#target(ric);
    if (auction) {
      throw new ExchangeAdminError(
        RejectReason.InvalidRequest,
        "resume via auction is not supported yet",
      );
    }
    book.phase = this.#marketPhase;
    book.haltReason = "";
    book.dirty = true;
    this.#journalBooks(this.#target(ric));
    return [book.ric];
  }

  setBotRate(
    ric: string | undefined,
    bot: BotType = BotType.All,
    rate: number,
  ): string[] {
    const targets = this.#target(ric);
    for (const sim of targets) {
      if (bot !== BotType.Taker) sim.mmRate = rate;
      if (bot !== BotType.MarketMaker) sim.takerRate = rate;
    }
    this.#journalBooks(targets);
    return targets.map(({ book }) => book.ric);
  }

  // ---------------------------------------------------------------- persistence

  /**
   * Write-ahead journal hook (see docs/persistence.md): gateway reports,
   * trade id reservations, admin and session changes. Undefined = off.
   */
  setJournal(journal: ExchangeJournal | undefined) {
    this.#journal = journal;
    this.gateway.setJournal(
      journal ? (r) => journal({ k: "report", r }) : undefined,
    );
    // Re-reserve on the next trade so the journal covers every id issued.
    this.#tradeReserved = this.#tradeSeq;
  }

  #journalSession() {
    this.#journal?.({
      k: "session",
      marketPhase: this.#marketPhase,
      forced: this.#forced ? { ...this.#forced } : undefined,
    });
  }

  #settings({ book, mmRate, takerRate }: SimulatedInstrument): BookSettings {
    return {
      ric: book.ric,
      phase: book.phase,
      haltReason: book.haltReason,
      volatility: book.model.volatility,
      mmRate,
      takerRate,
    };
  }

  #journalBooks(targets: SimulatedInstrument[]) {
    if (!this.#journal) return;
    for (const sim of targets)
      this.#journal({ k: "book", b: this.#settings(sim) });
  }

  /** Persistable state: counters, session, settings and resting gateway orders. */
  exportState(): ExchangeState {
    return {
      version: 1,
      tradeSeq: this.#tradeSeq,
      marketPhase: this.#marketPhase,
      forced: this.#forced ? { ...this.#forced } : undefined,
      gateway: this.gateway.exportState(),
      books: [...this.#simulated.values()].map((sim) => {
        const { book } = sim;
        const snapshot = book.book.snapshot();
        const orders = [...snapshot.bids, ...snapshot.asks].flatMap((level) =>
          level.orders.filter((o) => o.owner === GATEWAY_OWNER),
        );
        return {
          ...this.#settings(sim),
          fair: book.model.fairValue,
          stats: { ...book.stats },
          seq: book.seq,
          orders,
        };
      }),
    };
  }

  /**
   * Restore from a snapshot plus the exchange journal entries after it, in
   * order. Call on a fresh simulator, before tables attach, `start()` or any
   * order flow. Live gateway orders go back into their books in time
   * priority (snapshot order, then journal order for new / re-queued ones);
   * bot liquidity is not restored. Book stats and fair values come from the
   * snapshot (journal entries only carry customer order state).
   */
  restoreState(
    state: ExchangeState | undefined,
    entries: readonly ExchangeJournalEntry[] = [],
  ): ExchangeRestoreResult {
    if (state && state.version !== 1) {
      throw Error(`unsupported exchange state version ${state.version}`);
    }
    let tradeSeq = state?.tradeSeq ?? 0;
    let marketPhase = state?.marketPhase ?? this.#marketPhase;
    let forced = state?.forced;
    const settings = new Map<string, BookSettings>();
    const reports: ExecutionReport[] = [];
    for (const book of state?.books ?? []) settings.set(book.ric, book);
    for (const entry of entries) {
      switch (entry.k) {
        case "report":
          reports.push(entry.r);
          break;
        case "tradeSeq":
          tradeSeq = Math.max(tradeSeq, entry.upTo);
          break;
        case "book":
          settings.set(entry.b.ric, entry.b);
          break;
        case "session":
          marketPhase = entry.marketPhase;
          forced = entry.forced;
          break;
      }
    }
    for (const r of reports) {
      if (r.tradeId) tradeSeq = Math.max(tradeSeq, Number(r.tradeId.slice(2)));
    }
    this.#tradeSeq = tradeSeq;
    this.#tradeReserved = tradeSeq;
    this.#forced = forced ? { ...forced } : undefined;
    this.#marketPhase = marketPhase;

    this.gateway.restoreState(state?.gateway, reports);

    // Time priority: snapshot order, then (re-)queued in journal order.
    const snapshotOrders = new Map<string, ILimitOrder>();
    const priority: string[] = [];
    for (const book of state?.books ?? []) {
      for (const order of book.orders) {
        snapshotOrders.set(order.id, order);
        priority.push(order.id);
      }
    }
    const requeued = new Set<string>();
    for (const r of reports) {
      if (
        (r.execType === ExecType.New && r.responseTo === "NEW") ||
        (r.execType === ExecType.Replaced && r.priorityKept !== true)
      ) {
        requeued.add(r.exchangeOrderId);
        priority.push(r.exchangeOrderId);
      }
    }
    const live = new Map<string, ExecutionReport>();
    for (const report of this.gateway.liveOrders())
      live.set(report.exchangeOrderId, report);
    const byRic = new Map<string, ILimitOrder[]>();
    const placed = new Set<string>();
    // Last occurrence wins for re-queued orders, first for the rest.
    const lastIndex = new Map<string, number>();
    priority.forEach((id, i) => {
      lastIndex.set(id, i);
    });
    priority.forEach((id, i) => {
      const report = live.get(id);
      if (!report || placed.has(id) || report.ordType !== OrdType.Limit) return;
      if (requeued.has(id) && lastIndex.get(id) !== i) return;
      placed.add(id);
      const saved = snapshotOrders.get(id);
      const order: ILimitOrder = {
        ...(saved ?? {
          id,
          type: BookOrderType.LIMIT,
          side: toBookSide(report.side),
          origSize: report.quantity,
          time: report.timestamp,
          timeInForce: BookTif.GTC,
          makerQty: report.leavesQty,
          takerQty: 0,
          accountId: report.account,
          owner: GATEWAY_OWNER,
          meta: report.clOrdId,
        }),
        size: report.leavesQty,
        price: report.price,
      };
      const list = byRic.get(report.ric) ?? [];
      list.push(order);
      byRic.set(report.ric, list);
    });

    for (const sim of this.#simulated.values()) {
      const { book } = sim;
      const saved = state?.books.find((b) => b.ric === book.ric);
      const s = settings.get(book.ric);
      if (s) {
        book.model.volatility = s.volatility;
        sim.mmRate = s.mmRate;
        sim.takerRate = s.takerRate;
        book.haltReason = s.haltReason;
      }
      book.phase =
        s?.phase === TradingPhase.Halted ? TradingPhase.Halted : marketPhase;
      if (saved) book.model.fairValue = saved.fair;
      book.restore(byRic.get(book.ric) ?? [], this.gateway, {
        seq: saved?.seq ?? 0,
        stats: saved?.stats,
      });
    }
    const droppedOrders = [...live.values()]
      .filter(
        (r) => !this.#simulated.has(r.ric) || !placed.has(r.exchangeOrderId),
      )
      .map((r) => r.exchangeOrderId);
    return { restoredOrders: placed.size, droppedOrders, tradeSeq };
  }

  /**
   * After a restore: apply the session schedule at `now`. If a market close
   * fell between `since` (when the state was last persisted) and `now`, DAY
   * orders are expired (EXPIRED reports reach the OMS), as they would have
   * been had the server been running. Returns the expired exchange order ids.
   */
  catchUpSession(since: number, now = this.clock()) {
    const expired = this.#closeBetween(since, now)
      ? this.gateway.expireDayOrders(
          undefined,
          "DAY order expired at market close (server was down)",
        )
      : [];
    this.updateSession(now);
    return expired;
  }

  #closeBetween(since: number, now: number) {
    const { session } = this;
    if (!session.scheduled || now <= since) return false;
    if (now - since >= session.dayMs) return true;
    let t = since;
    for (let i = 0; i < 4; i++) {
      const next = session.nextChangeAt(t);
      if (next === undefined || next > now) return false;
      if (session.phaseAt(next) === TradingPhase.Closed) return true;
      t = next;
    }
    return false;
  }
}

export const createExchangeSimulator = (options?: ExchangeSimulatorOptions) =>
  new ExchangeSimulator(options);
