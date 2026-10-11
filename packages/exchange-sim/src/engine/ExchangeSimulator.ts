import type { Trade } from "@heswell/hft-limit-order-book";
import {
  BotType,
  RejectReason,
  roundToLot,
  TradingPhase,
} from "@heswell/trading-schemas";
import {
  DEFAULT_CONFIG,
  type ExchangeSimConfig,
  validateConfig,
} from "../config";
import { SimExchangeGateway } from "../gateway/SimExchangeGateway";
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
import { fromBookSide, InstrumentBook } from "./InstrumentBook";

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
  /** Book events deferred because a step hit maxOpsPerStep. */
  deferredSteps = 0;

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

  // ---------------------------------------------------------------- time

  /** Advance prices and bots to `now`. */
  step(now = this.clock()) {
    const { config } = this;
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
    return targets.map(({ book }) => book.ric);
  }

  haltInstrument(ric: string, reason = ""): string[] {
    const [{ book }] = this.#target(ric);
    book.phase = TradingPhase.Halted;
    book.haltReason = reason;
    book.dirty = true;
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
    book.phase = TradingPhase.Continuous;
    book.haltReason = "";
    book.dirty = true;
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
    return targets.map(({ book }) => book.ric);
  }
}

export const createExchangeSimulator = (options?: ExchangeSimulatorOptions) =>
  new ExchangeSimulator(options);
