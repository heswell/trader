import {
  OrderType as BookOrderType,
  Side as BookSide,
  TimeInForce as BookTif,
  type Trade,
} from "@heswell/hft-limit-order-book";
import {
  activityAt,
  BotType,
  ExecType,
  OrdType,
  RejectReason,
  roundToLot,
  roundToTick,
  type SessionSchedule,
  TradingPhase,
  VOLUME_PROFILES,
  type VolumeProfileName,
  usdPerUnit,
} from "@heswell/trading-schemas";
import {
  barIntervalList,
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
  carriedPrice,
  isContinuation,
  isFuture,
  listContinuations,
  listFutures,
  quarterlyExpiries,
  toFutureDef,
  withFutures,
} from "../reference/futures";
import {
  indexLevel,
  isIndex,
  isIndexRic,
  listIndices,
  withConstituents,
} from "../reference/indices";
import {
  ALL_INSTRUMENTS,
  type InstrumentDef,
  selectActiveInstruments,
} from "../reference/instruments";
import { type Timer, TimerRegistry } from "@heswell/trading-metrics";
import { ControlPublisher } from "../publish/ControlPublisher";
import { SimAdminPublisher } from "../publish/SimAdminPublisher";
import { type Clock, systemClock } from "../util/clock";
import { Random } from "../util/random";
import { generateBackfillBars } from "./barBackfill";
import { SECONDS_PER_YEAR } from "./PriceModel";
import { BUILT_IN_SCENARIOS } from "../../scenarios";
import { type SavedRun, ScenarioRunner } from "./control/ScenarioRunner";
import { SimControl } from "./control/SimControl";
import { ExchangeAdminError } from "./errors";
import { FlowTally, type TradeParty, tradeParty } from "./flow";
import { calibrateImpact } from "./impact";
import { type Bot, BotKind, type BotParams } from "./bots/Bot";
import { MarketSignals } from "./bots/MarketSignals";
import type { NoiseTaker } from "./bots/NoiseTaker";
import {
  botKindDef,
  createBot,
  createBots,
  type ExtraBots,
  parseExtraBots,
  futuresRosterFor,
  hashString,
  rosterFor,
  sortBots,
} from "./bots/roster";
import {
  type BookTimers,
  fromBookSide,
  InstrumentBook,
  toBookSide,
} from "./InstrumentBook";
import {
  type BookSettings,
  type BotConfig,
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
  /** Quoting bots first, then takers (step order). Changed by addBot / removeBot. */
  readonly bots: Bot[];
  /** Generator new bots fork from (by local id). */
  readonly botRng: Random;
  /** Shared recent-market view, updated once per step for the bots. */
  readonly signals: MarketSignals;
  /** Market maker base size (lots), from baseNotionalUsd. */
  readonly baseQty: number;
  readonly modelRng: Random;
  /** MARKET_MAKER discretionary churn, events/s for the instrument (0 = paused). */
  mmRate: number;
  /** TAKER orders/s for the instrument (0 = paused). */
  takerRate: number;
  /** Activity multiplier applied to takerRate at the last step (1 unscheduled). */
  activity: number;
  /** Random variation of taker activity around the volume curve. */
  readonly noise: ActivityNoise;
  /** Bots by id (`<ric>/<localId>`), for trade attribution. */
  readonly botIndex: Map<string, Bot>;
  /** Aggressive volume by owner group since the last sim sample. */
  readonly flow: FlowTally;
}

/** Log-space activity noise: a per-day level plus a mean-reverting wander. */
interface ActivityNoise {
  readonly rng: Random;
  day: number | undefined;
  level: number;
  wander: number;
}

/** Salt of the generator every bot on an instrument forks from. */
const BOT_RNG_SALT = 500;

/** Comma separated config list: trimmed, empty entries dropped. */
const splitList = (text: string) =>
  text
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

/** Mean-reversion time of the activity wander, as a fraction of the session. */
const WANDER_SESSION_FRACTION = 0.05;

export interface ExchangeSimulatorOptions {
  config?: Partial<ExchangeSimConfig>;
  clock?: Clock;
  /** Listed instruments (default: the bundled universe). */
  universe?: readonly InstrumentDef[];
}

/** Admin request failure, mapped to an RPC ERROR_RESULT by the admin service. */
export { ExchangeAdminError } from "./errors";

export type TapeListener = (trade: TapeTrade) => void;

/** A listed synthetic index: its constituents' books and reference prices. */
interface IndexState {
  def: InstrumentDef;
  books: InstrumentBook[];
  refs: number[];
}

/** What a future anchors on: a stock's fair value or an index level. */
interface Spot {
  price(): number;
  /** Price to list the next contract from (on tick for a stock). */
  listPrice(): number;
  volatility: number;
}

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
  #universe: InstrumentDef[];
  /** Futures with a live book that have not expired yet. */
  readonly #liveFutures: SimulatedInstrument[] = [];
  /** Listed synthetic indices, by ric. */
  readonly #indices = new Map<string, IndexState>();
  /** Futures last-trading time of day, "HH:MM" UTC. */
  readonly #expiryTime: string;
  readonly gateway: SimExchangeGateway;
  readonly session: TradingSession;
  /** Session times and volume curve, as the OMS sees them. */
  readonly sessionSchedule: SessionSchedule;
  readonly #listed = new Map<string, InstrumentDef>();
  readonly #simulated = new Map<string, SimulatedInstrument>();
  readonly #books: InstrumentBook[] = [];
  readonly #tapeListeners = new Set<TapeListener>();
  #publisher: MarketDataPublisher | undefined;
  #simAdmin: SimAdminPublisher | undefined;
  #controlPublisher: ControlPublisher | undefined;
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
  /**
   * Hot-path timers (matching, step, flush, gateway requests), untimed
   * until the server sets a mode (metrics.timers).
   */
  readonly timers = new TimerRegistry();
  readonly #bookTimers: BookTimers;
  readonly #stepTiming: Timer;
  readonly #flushTiming: Timer;
  #journal: ExchangeJournal | undefined;
  #control: SimControl | undefined;
  readonly #extraBots: ExtraBots[];
  #scenarios: ScenarioRunner | undefined;
  /** Trade ids up to this value are journaled as reserved. */
  #tradeReserved = 0;

  constructor({
    config = {},
    clock = systemClock,
    universe = ALL_INSTRUMENTS,
  }: ExchangeSimulatorOptions = {}) {
    this.config = validateConfig({ ...DEFAULT_CONFIG, ...config });
    this.#extraBots = parseExtraBots(this.config.extraBots);
    const t = this.timers;
    this.#bookTimers = {
      limit: t.timer("exchange", "limit"),
      market: t.timer("exchange", "market"),
      modify: t.timer("exchange", "modify"),
      cancel: t.timer("exchange", "cancel"),
    };
    this.#stepTiming = t.timer("exchange", "step");
    this.#flushTiming = t.timer("publisher", "flush");
    this.clock = clock;
    this.#expiryTime = this.config.sessionClose || "16:30";
    const futureUnderlyings = splitList(this.config.futures);
    const indices = listIndices(universe, [
      ...splitList(this.config.indices),
      ...futureUnderlyings.filter(isIndexRic),
    ]);
    const futures = listFutures(
      [...universe, ...indices],
      futureUnderlyings,
      clock(),
      {
        contracts: this.config.futuresContracts,
        carryRate: this.config.futuresCarryRate,
        expiryTime: this.#expiryTime,
      },
    );
    this.#universe = [...universe, ...indices, ...futures];
    for (const instrument of this.#universe)
      this.#listed.set(instrument.ric, instrument);

    // listed futures always get a book (with their underlyings), indices
    // their constituents' books; the rest of the selection is equities only
    const derived = new Set([...indices, ...futures].map((i) => i.ric));
    const rics = splitList(this.config.instruments);
    const equityRics = rics.filter((ric) => !derived.has(ric));
    const active = withFutures(
      withConstituents(
        rics.length > 0 && equityRics.length === 0
          ? []
          : selectActiveInstruments(
              universe.filter((i) => !isFuture(i) && !isIndex(i)),
              this.config.activeInstruments,
              equityRics,
            ),
        indices,
        universe,
      ),
      futures,
      this.#universe,
    );
    const rng = new Random(this.config.seed);
    for (const [i, instrument] of active.entries()) {
      this.#addInstrument(instrument, rng.fork(i));
    }
    for (const index of indices) this.#indexState(index.ric);
    for (const ric of new Set(futures.map((f) => f.underlying ?? "")))
      this.#relistContinuations(ric);
    this.gateway = new SimExchangeGateway({
      clock,
      getInstrument: (ric) => this.#listed.get(ric),
      getBook: (ric) => this.#simulated.get(ric)?.book,
      getSessionSchedule: () => this.sessionSchedule,
      onTape: (listener) => this.onTape(listener),
      timers: this.timers,
    });
    this.session = new TradingSession(this.config);
    this.sessionSchedule = this.session.schedule(
      VOLUME_PROFILES[this.config.volumeProfile as VolumeProfileName],
    );
    this.updateSession(clock());
  }

  #addInstrument(instrument: InstrumentDef, rng: Random) {
    const { config } = this;
    // forked before any draw, so bot streams don't depend on the rest
    const botRng = rng.fork(BOT_RNG_SALT);
    const underlying = isFuture(instrument)
      ? this.#spotOf(instrument.underlying ?? "")
      : undefined;
    const drawn =
      config.defaultVolatility > 0
        ? config.defaultVolatility
        : rng.uniform(0.2, 0.5);
    // a future is as volatile as its underlying
    const volatility = underlying?.volatility ?? drawn;
    const book = new InstrumentBook(
      instrument,
      volatility,
      config.priceBandPct,
      this.clock,
      (b, trade) => this.#onTrade(b, trade),
    );
    book.timers = this.#bookTimers;
    const { refPrice, lotSize } = instrument;
    const usdPer = usdPerUnit(instrument);
    const baseQty = Math.max(
      lotSize,
      roundToLot(config.baseNotionalUsd / (refPrice * usdPer), lotSize),
    );
    const calibration = calibrateImpact(
      config,
      config.takerRate,
      baseQty * refPrice * usdPer,
    );
    book.model.impact = calibration.impact;
    book.model.walkVolShare = calibration.walkVolShare;
    if (underlying) {
      const { expiry = 0 } = instrument;
      const { futuresCarryRate, futuresBasisBps, futuresBasisHalfLifeSec } =
        config;
      book.model.anchor = {
        price: () =>
          carriedPrice(
            underlying.price(),
            futuresCarryRate,
            expiry,
            this.clock(),
          ),
        basisBps: futuresBasisBps,
        halfLifeSec: futuresBasisHalfLifeSec,
      };
    }
    const bots = createBots(
      underlying
        ? futuresRosterFor(config, this.#extraBots, instrument.sector)
        : rosterFor(config, this.#extraBots, instrument.sector),
      book,
      botRng,
      baseQty,
    );
    this.#simulated.set(instrument.ric, {
      book,
      bots,
      botRng,
      botIndex: new Map(bots.map((bot) => [bot.id, bot])),
      flow: new FlowTally(),
      signals: Object.assign(new MarketSignals(), {
        // the instrument's normal volatility, per wall-clock second
        refVolBpsPerSqrtSec:
          volatility * 1e4 * Math.sqrt(config.timeScale / SECONDS_PER_YEAR),
      }),
      baseQty,
      modelRng: rng.fork(300),
      mmRate: config.mmRate,
      takerRate: config.takerRate,
      activity: 1,
      noise: { rng: rng.fork(400), day: undefined, level: 0, wander: 0 },
    });
    this.#books.push(book);
    if (underlying)
      this.#liveFutures.push(
        this.#simulated.get(instrument.ric) as SimulatedInstrument,
      );
  }

  /** A listed index, once its constituents have books (cached). */
  #indexState(ric: string): IndexState | undefined {
    const known = this.#indices.get(ric);
    if (known) return known;
    const def = this.#listed.get(ric);
    if (!def || !isIndex(def)) return undefined;
    const books: InstrumentBook[] = [];
    for (const c of def.constituents ?? []) {
      const book = this.#simulated.get(c)?.book;
      if (book) books.push(book);
    }
    if (books.length === 0) return undefined;
    const state = {
      def,
      books,
      refs: books.map((b) => b.instrument.refPrice),
    };
    this.#indices.set(ric, state);
    return state;
  }

  /** Spot a future on `ric` anchors on: a simulated stock or a listed index. */
  #spotOf(ric: string): Spot | undefined {
    const book = this.#simulated.get(ric)?.book;
    if (book) {
      return {
        price: () => book.model.fairValue,
        listPrice: () => book.model.fairOnTick,
        volatility: book.model.volatility,
      };
    }
    const index = this.#indexState(ric);
    if (!index) return undefined;
    const price = () => this.#level(index);
    // independent constituent walks: the basket's vol shrinks with its size
    const vols = index.books.map((b) => b.model.volatility);
    const volatility =
      Math.sqrt(vols.reduce((sum, v) => sum + v * v, 0)) / vols.length;
    return { price, listPrice: price, volatility };
  }

  #level(index: IndexState) {
    return indexLevel(
      index.refs,
      index.books.map((b) => b.model.fairValue),
    );
  }

  /** Current level of a listed index (undefined if `ric` is not one). */
  indexLevel(ric: string): number | undefined {
    const index = this.#indexState(ric);
    return index ? this.#level(index) : undefined;
  }

  /** Listed synthetic indices. */
  get indices(): readonly InstrumentDef[] {
    return [...this.#indices.values()].map((i) => i.def);
  }

  /** Every listed instrument: the universe, its futures and any listed since. */
  get universe(): readonly InstrumentDef[] {
    return this.#universe;
  }

  /** Expire every live future whose last trading time has passed. */
  #expireDueFutures(now: number) {
    for (const sim of [...this.#liveFutures]) {
      const { expiry } = sim.book.instrument;
      if (expiry !== undefined && expiry <= now)
        this.expireFuture(sim.book.ric, now);
    }
  }

  /**
   * Expire a future now: settle at its underlying's fair value or index
   * level (on tick),
   * close its book for good, expire its resting orders, tell gateway
   * subscribers (the OMS settles positions), then list the next quarterly
   * contract. Called by step() at the expiry time. Returns the settlement
   * price.
   */
  expireFuture(ric: string, now = this.clock()): number {
    const sim = this.#simulated.get(ric);
    const def = this.#listed.get(ric);
    if (!sim || !def || !isFuture(def)) {
      throw new ExchangeAdminError(
        RejectReason.UnknownInstrument,
        `${ric} is not a simulated future`,
      );
    }
    const { book } = sim;
    if (book.settlementPrice !== undefined) return book.settlementPrice;
    const spot = this.#spotOf(def.underlying ?? "");
    const settlementPrice = roundToTick(
      spot?.price() ?? book.model.fairValue,
      book.schedule,
    );
    book.settlementPrice = settlementPrice;
    book.phase = TradingPhase.Closed;
    book.haltReason = "expired";
    book.dirty = true;
    for (const bot of sim.bots) bot.pull();
    this.gateway.expireAllOrders(ric, `${ric} expired`);
    const expired: InstrumentDef = { ...def, settlementPrice };
    this.#listed.set(ric, expired);
    this.#universe[this.#universe.indexOf(def)] = expired;
    this.#publisher?.updateInstrument(expired, true);
    this.#liveFutures.splice(this.#liveFutures.indexOf(sim), 1);
    this.gateway.emitInstrumentEvent({
      type: "EXPIRED",
      ric,
      settlementPrice,
      timestamp: now,
    });
    this.#rollFuture(def, now);
    this.#relistContinuations(def.underlying ?? "");
    return settlementPrice;
  }

  /**
   * Point an underlying's continuations (c1..cN) at its live contracts,
   * nearest expiry first: listed at startup, repointed after each roll.
   */
  #relistContinuations(ric: string) {
    const underlying = this.#listed.get(ric);
    if (!underlying) return;
    const live = this.#liveFutures
      .map((sim) => sim.book.instrument)
      .filter((i) => i.underlying === ric);
    for (const def of listContinuations(underlying, live)) {
      const prev = this.#listed.get(def.ric);
      this.#listed.set(def.ric, def);
      if (prev) {
        this.#universe[this.#universe.indexOf(prev)] = def;
        this.#publisher?.updateInstrument(def, true);
      } else {
        this.#universe.push(def);
        this.#publisher?.addInstrument(def, true);
      }
      this.#publisher?.setAlias(def.ric, def.contract ?? "");
    }
  }

  /** List the quarterly contract after the last one listed on `expired`'s underlying. */
  #rollFuture(expired: InstrumentDef, now: number) {
    const ric = expired.underlying ?? "";
    const underlying = this.#listed.get(ric);
    const spot = this.#spotOf(ric);
    if (!underlying || !spot) return;
    const latest = Math.max(
      now,
      ...this.#universe
        .filter((i) => i.underlying === ric)
        .map((i) => i.expiry ?? 0),
    );
    const [expiry] = quarterlyExpiries(latest, 1, this.#expiryTime);
    const next = toFutureDef(
      { ...underlying, refPrice: spot.listPrice() },
      expiry,
      now,
      this.config.futuresCarryRate,
    );
    // ten years on the ric comes round again: keep the old listing
    if (this.#listed.has(next.ric)) return;
    this.#universe.push(next);
    this.#listed.set(next.ric, next);
    this.#addInstrument(
      next,
      new Random(this.config.seed).fork(hashString(next.ric)),
    );
    const sim = this.#simulated.get(next.ric) as SimulatedInstrument;
    sim.book.phase = this.#marketPhase;
    this.#publisher?.addInstrument(next, true);
    this.#publisher?.l3?.attach([sim.book]);
    this.#simAdmin?.loadBotParams([sim]);
    this.#simAdmin?.botsChanged(sim);
    this.gateway.emitInstrumentEvent({
      type: "LISTED",
      ric: next.ric,
      timestamp: now,
    });
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

  /** Bots on one instrument, or on every simulated instrument. */
  getBots(ric?: string): readonly Bot[] {
    if (ric !== undefined) return this.#simulated.get(ric)?.bots ?? [];
    return [...this.#simulated.values()].flatMap((sim) => sim.bots);
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
    const sim = this.#simulated.get(book.ric);
    const isBuy = trade.side === BookSide.BUY;
    let taker: TradeParty | undefined;
    let maker: TradeParty | undefined;
    if (sim) {
      sim.signals.onTrade(trade);
      taker = tradeParty(trade.takerOwner, trade.takerAccountId, sim.botIndex);
      maker = tradeParty(trade.makerOwner, trade.makerAccountId, sim.botIndex);
      sim.flow.add(taker.group, isBuy, trade.size);
      book.model.applyImpact(
        isBuy ? 1 : -1,
        trade.price * trade.size * usdPerUnit(book.instrument),
      );
    }
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
    if (sim && maker && taker)
      this.#simAdmin?.addFills(sim, trade, tradeId, maker, taker);
    return tradeId;
  }

  // ---------------------------------------------------------------- tables

  /** Bind the Vuu tables, load static rows and publish the initial state. */
  attachTables(tables: ExchangeTables) {
    if (this.#publisher)
      throw Error("ExchangeSimulator: tables already attached");
    const { config } = this;
    const decimals = (ric: string) => this.#listed.get(ric)?.priceDecimals ?? 2;
    const publisher = new MarketDataPublisher(
      tables,
      config.depthLevels,
      config.tradesCapacity,
      {
        bars: {
          intervals: barIntervalList(config.barIntervals),
          history: config.barHistory,
          decimals,
        },
        bookSamples: {
          intervalMs: config.bookSampleIntervalMs,
          history: config.bookSampleHistory,
          decimals,
        },
        l3: {
          orders: config.bookOrders === 1,
          events: config.bookEvents === 1,
          eventsCapacity: config.bookEventsCapacity,
        },
      },
    );
    publisher.loadInstruments(
      this.#universe,
      // live quotes: a book, an index level, or a continuation's contract
      (ric) => {
        const def = this.#listed.get(ric);
        return (
          this.isSimulated(ric) ||
          this.#indices.has(ric) ||
          (def !== undefined && isContinuation(def))
        );
      },
    );
    for (const def of this.#universe)
      if (isContinuation(def)) publisher.setAlias(def.ric, def.contract ?? "");
    publisher.l3?.attach(this.#books);
    this.#publisher = publisher;
    const { simBooks, bots, botParams, simSamples, botHistory, botFills } =
      tables;
    if (simBooks && bots && botParams && config.simPublishIntervalMs > 0) {
      this.#simAdmin = new SimAdminPublisher(
        { simBooks, bots, botParams, simSamples, botHistory, botFills },
        {
          intervalMs: config.simPublishIntervalMs,
          timeScale: config.timeScale,
          sampleIntervalMs: config.simSampleIntervalMs,
          sampleHistory: config.simSampleHistory,
          botHistoryIntervalMs: config.botHistoryIntervalMs,
          botHistorySamples: config.botHistorySamples,
          fillsCapacity: config.botFillsCapacity,
          markoutMs: config.markoutMs,
        },
      );
      this.#simAdmin.loadBotParams(this.#simulated.values());
      const { simEvents, scenarios, scenarioRuns, simSession } = tables;
      this.#controlPublisher = new ControlPublisher(this, {
        simEvents,
        scenarios,
        scenarioRuns,
        simSession,
      });
    }
    if (config.barBackfill && publisher.bars) this.#backfillBars(publisher);
    this.flush();
    return publisher;
  }

  /**
   * Seed synthetic closed bars from the price model (see barBackfill), with
   * a dedicated RNG so the live market's random streams are untouched.
   */
  #backfillBars(publisher: MarketDataPublisher) {
    const bars = publisher.bars as NonNullable<MarketDataPublisher["bars"]>;
    const { config } = this;
    const now = this.clock();
    const rng = new Random((config.seed ^ 0x5bd1e995) >>> 0);
    for (const [i, book] of this.#books.entries()) {
      const sim = this.#simulated.get(book.ric) as SimulatedInstrument;
      const bookRng = rng.fork(i);
      for (const [j, { label, ms }] of bars.intervals.entries()) {
        bars.backfill(
          book.ric,
          label,
          generateBackfillBars({
            model: book.model,
            lotSize: book.instrument.lotSize,
            tradeSize: takerTradeSize(sim),
            takerRate: sim.takerRate,
            timeScale: config.timeScale,
            intervalMs: ms,
            count: config.barHistory,
            now,
            rng: bookRng.fork(j),
            activity: (time) => activityAt(this.sessionSchedule, time),
          }),
        );
      }
    }
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
      // halted books stay halted; expired futures stay closed
      if (book.phase === TradingPhase.Halted || book.isExpired) continue;
      book.phase = phase;
      book.dirty = true;
    }
    if (phase === TradingPhase.Closed) {
      for (const sim of this.#simulated.values()) {
        for (const bot of sim.bots) bot.pull();
        sim.book.model.recentre();
      }
      this.gateway.expireDayOrders();
    }
  }

  /** Run-time admin actions, recorded as SimEvents. */
  get control(): SimControl {
    this.#control ??= new SimControl(this);
    return this.#control;
  }

  /** Scenario definitions and runs (the built-in scenarios are defined). */
  get scenarios(): ScenarioRunner {
    if (!this.#scenarios) {
      this.#scenarios = new ScenarioRunner(this);
      this.#scenarios.define(...BUILT_IN_SCENARIOS);
    }
    return this.#scenarios;
  }

  /** Write a journal entry (no-op while the journal is off). */
  journal(entry: ExchangeJournalEntry) {
    this.#journal?.(entry);
  }

  // ---------------------------------------------------------------- time

  /** Advance the session, prices and bots to `now`. */
  step(now = this.clock()) {
    const timer = this.#stepTiming;
    const t0 = timer.start();
    this.#step(now);
    timer.stop(t0);
  }

  #step(now: number) {
    const { config } = this;
    this.updateSession(now);
    const elapsed =
      this.#lastStep === undefined ? config.botStepMs : now - this.#lastStep;
    this.#lastStep = now;
    this.#control?.step(now);
    this.#scenarios?.step(now);
    if (this.#liveFutures.length > 0) this.#expireDueFutures(now);
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
      book.model.step(modelDt, sim.modelRng, dt);
      this.#stepBots(sim, now, dt);
      ops += book.events - before;
    }
    this.#cursor = (this.#cursor + 1) % Math.max(count, 1);
  }

  /**
   * Update the instrument's signals, then step its bots in roster order.
   * A bot in a rate group gets an even share of the group's rate (takers
   * scaled by the activity curve) and is skipped while that rate is 0.
   */
  #stepBots(sim: SimulatedInstrument, now: number, dt: number) {
    const { book, signals, bots } = sim;
    const top = book.topOfBook();
    signals.update(dt, top.bid, top.ask);
    let mmCount = 0;
    let takerCount = 0;
    for (const bot of bots) {
      if (bot.port.paused) continue;
      const group = botKindDef(bot.kind).rateGroup;
      if (group === BotType.MarketMaker) mmCount++;
      else if (group === BotType.Taker) takerCount++;
    }
    const mmRate = sim.mmRate > 0 ? sim.mmRate / mmCount : 0;
    if (sim.takerRate > 0) sim.activity = this.#activity(sim, now, dt);
    const takerRate =
      sim.takerRate > 0 ? (sim.takerRate * sim.activity) / takerCount : 0;
    for (const bot of bots) {
      if (bot.port.paused) continue;
      const group = botKindDef(bot.kind).rateGroup;
      const rate =
        group === BotType.MarketMaker
          ? mmRate
          : group === BotType.Taker
            ? takerRate
            : 0;
      if (group !== undefined && !(rate > 0)) continue;
      bot.step({ dt, now, rate, signals });
      if (botKindDef(bot.kind).limits) this.#checkLimits(sim, bot, dt);
    }
  }

  /**
   * Order port limits (maxPositionUsd, maxOrdersPerSec params): a breach
   * pulls and pauses the bot and is recorded in simEvents.
   */
  #checkLimits(sim: SimulatedInstrument, bot: Bot, dt: number) {
    const { port, params } = bot;
    port.updateRate(dt);
    const maxUsd = Number(params.maxPositionUsd) || 0;
    const maxRate = Number(params.maxOrdersPerSec) || 0;
    let reason = "";
    if (maxUsd > 0) {
      const usd =
        Math.abs(port.ledger.position) *
        sim.book.model.fairValue *
        usdPerUnit(sim.book.instrument);
      if (usd > maxUsd)
        reason = `position $${Math.round(usd)} over maxPositionUsd ${maxUsd}`;
    }
    if (!reason && maxRate > 0 && port.actionRate > maxRate)
      reason = `${port.actionRate.toFixed(1)} orders/s over maxOrdersPerSec ${maxRate}`;
    if (!reason) return;
    bot.pull();
    port.paused = true;
    this.journalSettings(sim.book.ric);
    this.control.record(
      "botLimitBreach",
      bot.id,
      { reason },
      { user: "limits" },
    );
    this.#simAdmin?.botsChanged(sim);
  }

  /**
   * Taker activity multiplier at `now`: the intraday volume curve times
   * random noise while a session schedule is configured, else 1.
   */
  #activity(sim: SimulatedInstrument, now: number, dt: number) {
    const schedule = this.sessionSchedule;
    if (!schedule.scheduled) return 1;
    const curve = activityAt(schedule, now);
    const sigma = this.config.volumeNoise / 2;
    if (sigma === 0) return curve;
    const noise = sim.noise;
    const day = Math.floor(now / schedule.dayMs);
    if (day !== noise.day) {
      noise.day = day;
      noise.level = sigma * noise.rng.normal();
    }
    const sessionMs =
      (((schedule.closeAt - schedule.openAt) % schedule.dayMs) +
        schedule.dayMs) %
        schedule.dayMs || schedule.dayMs;
    const tau = (sessionMs * WANDER_SESSION_FRACTION) / 1000;
    const a = Math.min(1, dt / tau);
    noise.wander +=
      -noise.wander * a + sigma * Math.sqrt(2 * a) * noise.rng.normal();
    return curve * Math.exp(noise.level + noise.wander);
  }

  /** Publish dirty books and pending trades. */
  flush(now = this.clock()) {
    const timer = this.#flushTiming;
    const t0 = timer.start();
    const publisher = this.#publisher;
    publisher?.flush(this.#books, now);
    if (publisher)
      for (const index of this.#indices.values())
        publisher.publishIndex(
          index.def,
          this.#level(index),
          this.#marketPhase,
          now,
        );
    if (this.#simAdmin?.flush(this.#simulated.values(), now))
      this.#controlPublisher?.publishSession(now);
    timer.stop(t0);
  }

  /** The sim-admin publisher, when its tables are attached. */
  get simAdminPublisher() {
    return this.#simAdmin;
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
    if (book.isExpired) {
      throw new ExchangeAdminError(
        RejectReason.InvalidRequest,
        `${ric} has expired`,
      );
    }
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

  #settings({
    book,
    bots,
    mmRate,
    takerRate,
  }: SimulatedInstrument): BookSettings {
    const { model } = book;
    return {
      ric: book.ric,
      phase: book.phase,
      haltReason: book.haltReason,
      volatility: model.volatility,
      mmRate,
      takerRate,
      modelSettings: {
        driftBpsPerHour: model.driftBpsPerHour,
        impactK: model.impact.k,
        impactPermanentShare: model.impact.permanentShare,
        impactHalfLifeSec: model.impact.halfLifeSec,
      },
      roster: bots.map((bot) => ({
        id: bot.localId,
        kind: bot.kind,
        params: { ...bot.params },
        paused: bot.port.paused,
      })),
    };
  }

  #applySettings(sim: SimulatedInstrument, s: BookSettings) {
    const { book } = sim;
    book.model.volatility = s.volatility;
    sim.mmRate = s.mmRate;
    sim.takerRate = s.takerRate;
    book.haltReason = s.haltReason;
    const m = s.modelSettings;
    if (m) {
      book.model.driftBpsPerHour = m.driftBpsPerHour;
      book.model.impact = {
        k: m.impactK,
        permanentShare: m.impactPermanentShare,
        halfLifeSec: m.impactHalfLifeSec,
      };
    }
    if (s.roster) this.#applyRoster(sim, s.roster);
  }

  /** An instrument's settings now (for a scenario to revert to). */
  settingsOf(ric: string): BookSettings {
    const [sim] = this.#target(ric);
    return structuredClone(this.#settings(sim));
  }

  /**
   * Put an instrument's settings back (a scenario revert): model, rates and
   * bots, and halted or not.
   */
  applySettings(settings: BookSettings) {
    const [sim] = this.#target(settings.ric);
    const { book } = sim;
    this.#applySettings(sim, settings);
    const halted = settings.phase === TradingPhase.Halted;
    if (!book.isExpired && halted !== (book.phase === TradingPhase.Halted)) {
      book.phase = halted ? TradingPhase.Halted : this.#marketPhase;
      if (halted) for (const bot of sim.bots) bot.pull();
    }
    book.dirty = true;
    this.#journalBooks([sim]);
    this.#simAdmin?.botsChanged(sim);
  }

  /** Simulated instruments: one (`ric`), or all (undefined / ""). */
  instrumentsFor(ric?: string): SimulatedInstrument[] {
    return this.#target(ric);
  }

  /** Journal an instrument's settings after a run-time change. */
  journalSettings(ric: string) {
    const sim = this.#simulated.get(ric);
    if (sim) this.#journalBooks([sim]);
  }

  // ---------------------------------------------------------------- bots

  /**
   * Add a bot of `kind` to an instrument (the next local id of its kind),
   * stepping in its stage's order. Its generator forks from the
   * instrument's by local id.
   */
  addBot(ric: string, kind: BotKind, params?: BotParams, n?: number): Bot {
    const [sim] = this.#target(ric);
    const def = botKindDef(kind);
    if (!def)
      throw new ExchangeAdminError(
        RejectReason.InvalidRequest,
        `unknown bot kind ${kind}`,
      );
    let next = n ?? 1;
    if (n === undefined)
      while (sim.botIndex.has(`${ric}/${def.localId(next)}`)) next++;
    const bot = createBot(def, next, sim.book, sim.botRng, sim.baseQty, params);
    sim.bots.push(bot);
    sortBots(sim.bots);
    sim.botIndex.set(bot.id, bot);
    this.#simAdmin?.botsChanged(sim);
    return bot;
  }

  /** Remove a bot: its quotes are pulled and its rows deleted. */
  removeBot(botId: string): Bot {
    const sim = this.#simulated.get(botId.split("/")[0] ?? "");
    const bot = sim?.botIndex.get(botId);
    if (!sim || !bot)
      throw new ExchangeAdminError(
        RejectReason.InvalidRequest,
        `unknown bot ${botId}`,
      );
    bot.pull();
    sim.bots.splice(sim.bots.indexOf(bot), 1);
    sim.botIndex.delete(botId);
    this.#simAdmin?.botsChanged(sim, bot);
    return bot;
  }

  /** A bot by id (`<ric>/<localId>`). */
  getBot(botId: string): Bot | undefined {
    return this.#simulated.get(botId.split("/")[0] ?? "")?.botIndex.get(botId);
  }

  /** Bring an instrument's bots in line with saved settings. */
  #applyRoster(sim: SimulatedInstrument, roster: readonly BotConfig[]) {
    const wanted = new Set(roster.map((c) => `${sim.book.ric}/${c.id}`));
    for (const bot of [...sim.bots])
      if (!wanted.has(bot.id)) this.removeBot(bot.id);
    for (const config of roster) {
      const id = `${sim.book.ric}/${config.id}`;
      let bot = sim.botIndex.get(id);
      if (!bot) {
        const def = botKindDef(config.kind as BotKind);
        if (!def) continue;
        // the local id's number, e.g. MM3 -> 3
        const n = Number(config.id.replace(/^\D+/, ""));
        if (!Number.isInteger(n) || def.localId(n) !== config.id) continue;
        bot = this.addBot(sim.book.ric, def.kind, config.params, n);
      }
      bot.params = { ...bot.params, ...config.params };
      bot.onParamsChanged?.();
      bot.port.paused = config.paused === true;
    }
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
      runs: this.#scenarios?.exportState() ?? [],
      books: [...this.#simulated.values()].map((sim) => {
        const { book } = sim;
        const snapshot = book.book.snapshot();
        const orders = [...snapshot.bids, ...snapshot.asks].flatMap((level) =>
          level.orders.filter((o) => o.owner === GATEWAY_OWNER),
        );
        return {
          ...this.#settings(sim),
          fair: book.model.fairValue,
          model: book.model.exportState(),
          stats: { ...book.stats },
          seq: book.seq,
          orders,
          bots: sim.bots.map((bot) => ({
            id: bot.localId,
            ledger: bot.port.ledger.exportState(),
          })),
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
    const runs = new Map<string, SavedRun>();
    for (const run of state?.runs ?? []) runs.set(run.runId, run);
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
        case "run":
          runs.set(entry.run.runId, entry.run);
          break;
        case "runEnd":
          runs.delete(entry.runId);
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
      if (s) this.#applySettings(sim, s);
      book.phase =
        s?.phase === TradingPhase.Halted ? TradingPhase.Halted : marketPhase;
      if (saved?.model) book.model.restoreState(saved.model);
      if (saved) book.model.fairValue = saved.fair;
      for (const { id, ledger } of saved?.bots ?? []) {
        sim.bots
          .find((bot) => bot.localId === id)
          ?.port.ledger.restoreState(ledger);
      }
      book.restore(byRic.get(book.ric) ?? [], this.gateway, {
        seq: saved?.seq ?? 0,
        stats: saved?.stats,
      });
    }
    // runs live when the server stopped: undo their changes
    if (runs.size > 0) this.scenarios.abortRestored([...runs.values()]);
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

/** Mean order size of the instrument's noise takers (for bar backfill). */
const takerTradeSize = (sim: SimulatedInstrument) => {
  const taker = sim.bots.find((bot) => bot.kind === BotKind.NoiseTaker) as
    | NoiseTaker
    | undefined;
  return taker?.params.baseQty ?? sim.baseQty * 0.6;
};

export const createExchangeSimulator = (options?: ExchangeSimulatorOptions) =>
  new ExchangeSimulator(options);
