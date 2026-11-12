import { Side as BookSide, type Trade } from "@heswell/hft-limit-order-book";
import {
  botFillKey,
  botFills as botFillsDef,
  botHistory as botHistoryDef,
  botHistoryKey,
  botParamKey,
  BotType,
  botParams as botParamsDef,
  bots as botsDef,
  Liquidity,
  Side,
  simBooks as simBooksDef,
  simSampleKey,
  simSamples as simSamplesDef,
  usdPerUnit,
} from "@heswell/trading-schemas";
import { type Bot, botBaseline } from "../engine/bots/Bot";
import { OWNER_GROUPS, type TradeParty } from "../engine/flow";
import { botKindDef } from "../engine/bots/roster";
import type { SimulatedInstrument } from "../engine/ExchangeSimulator";
import { SECONDS_PER_YEAR } from "../engine/PriceModel";
import { type PublishTable, RowLayout, type RowValue, round } from "./rows";
import { TradeRingBuffer } from "./TradeRingBuffer";

export interface SimAdminTables {
  simBooks: PublishTable;
  bots: PublishTable;
  botParams: PublishTable;
  simSamples?: PublishTable;
  botHistory?: PublishTable;
  botFills?: PublishTable;
}

export interface SimAdminOptions {
  /** simBooks / bots interval (ms). */
  intervalMs: number;
  /** Simulated seconds per wall-clock second (config timeScale). */
  timeScale: number;
  /** simSamples interval (ms, 0 = off) and samples kept per ric. */
  sampleIntervalMs?: number;
  sampleHistory?: number;
  /** botHistory interval (ms, 0 = off) and samples kept per bot. */
  botHistoryIntervalMs?: number;
  botHistorySamples?: number;
  /** botFills rows kept (0 = off) and the markout horizon (ms). */
  fillsCapacity?: number;
  markoutMs?: number;
}

/** Keys of a rolling per-entity history, oldest first. */
class History {
  readonly #keys = new Map<string, string[]>();
  #nextAt = 0;

  constructor(
    readonly table: PublishTable,
    readonly intervalMs: number,
    readonly size: number,
  ) {}

  /** The aligned sample time when a sample is due at `now`, else undefined. */
  due(now: number) {
    if (this.intervalMs <= 0 || now < this.#nextAt) return undefined;
    const time = Math.floor(now / this.intervalMs) * this.intervalMs;
    this.#nextAt = time + this.intervalMs;
    return time;
  }

  insert(entity: string, key: string, row: RowValue[]) {
    let keys = this.#keys.get(entity);
    if (!keys) {
      keys = [];
      this.#keys.set(entity, keys);
    }
    if (keys.at(-1) === key) return;
    this.table.insert(row);
    keys.push(key);
    if (keys.length > this.size) this.table.delete(keys.shift() as string);
  }
}

interface PendingMarkout {
  key: string;
  row: RowValue[];
  sim: SimulatedInstrument;
  price: number;
  /** +1 buy, -1 sell. */
  sign: number;
  at: number;
}

/** Weight of the latest interval in a bot's smoothed order rate. */
const RATE_SMOOTHING = 0.5;

const upsert = (table: PublishTable, key: string, row: RowValue[]) => {
  const rowIdx = table.rowIndexAtKey(key);
  if (rowIdx < 0) table.insert(row);
  else table.update(rowIdx, row);
};

const finite = (value: number, decimals: number) =>
  Number.isFinite(value) ? round(value, decimals) : null;

/** Mid, or fair value when the book is one-sided. */
const markOf = ({ book }: SimulatedInstrument) => {
  const top = book.topOfBook();
  return top.bid > 0 && top.ask > 0
    ? (top.bid + top.ask) / 2
    : book.model.fairValue;
};

/** Net position of the instrument's market makers. */
const makerInventory = (sim: SimulatedInstrument) => {
  let inventory = 0;
  for (const bot of sim.bots) {
    if (botKindDef(bot.kind).rateGroup === BotType.MarketMaker)
      inventory += bot.port.ledger.position;
  }
  return inventory;
};

/** Each bot's current rate: its share of its group's rate on the instrument. */
export const botRates = (sim: SimulatedInstrument) => {
  let makers = 0;
  let takers = 0;
  for (const bot of sim.bots) {
    const group = botKindDef(bot.kind).rateGroup;
    if (group === BotType.MarketMaker) makers++;
    else if (group === BotType.Taker) takers++;
  }
  return (bot: Bot) => {
    const group = botKindDef(bot.kind).rateGroup;
    if (group === BotType.MarketMaker) return sim.mmRate / Math.max(1, makers);
    if (group === BotType.Taker)
      return (sim.takerRate * sim.activity) / Math.max(1, takers);
    return 0;
  };
};

/**
 * Publishes the sim-admin tables: `simBooks` (one row per simulated
 * instrument) and `bots` every `intervalMs`, and `botParams` once (bot
 * parameters are fixed until they can be changed at run time).
 */
export class SimAdminPublisher {
  readonly #simBooks: RowLayout<typeof simBooksDef>;
  readonly #bots: RowLayout<typeof botsDef>;
  readonly #botParams: RowLayout<typeof botParamsDef>;
  readonly #samples?: {
    history: History;
    layout: RowLayout<typeof simSamplesDef>;
  };
  readonly #botHistory?: {
    history: History;
    layout: RowLayout<typeof botHistoryDef>;
  };
  readonly #fills?: {
    table: PublishTable;
    ring: TradeRingBuffer;
    layout: RowLayout<typeof botFillsDef>;
    pending: PendingMarkout[];
    head: number;
  };
  readonly intervalMs: number;
  readonly timeScale: number;
  readonly markoutMs: number;
  /** Orders count and time at the previous publish, per bot. */
  readonly #rates = new Map<
    string,
    { orders: number; at: number; rate: number }
  >();
  #nextAt = Number.NEGATIVE_INFINITY;
  #lastNow = 0;
  updates = 0;

  constructor(
    readonly tables: SimAdminTables,
    options: SimAdminOptions,
  ) {
    this.intervalMs = options.intervalMs;
    this.timeScale = options.timeScale;
    this.markoutMs = options.markoutMs ?? 5_000;
    this.#simBooks = new RowLayout(tables.simBooks, simBooksDef, null);
    this.#bots = new RowLayout(tables.bots, botsDef, null);
    this.#botParams = new RowLayout(tables.botParams, botParamsDef, null);
    const { simSamples, botHistory, botFills } = tables;
    if (simSamples && (options.sampleIntervalMs ?? 0) > 0) {
      this.#samples = {
        history: new History(
          simSamples,
          options.sampleIntervalMs ?? 0,
          options.sampleHistory ?? 300,
        ),
        layout: new RowLayout(simSamples, simSamplesDef, null),
      };
    }
    if (botHistory && (options.botHistoryIntervalMs ?? 0) > 0) {
      this.#botHistory = {
        history: new History(
          botHistory,
          options.botHistoryIntervalMs ?? 0,
          options.botHistorySamples ?? 120,
        ),
        layout: new RowLayout(botHistory, botHistoryDef, null),
      };
    }
    if (botFills && (options.fillsCapacity ?? 0) > 0) {
      this.#fills = {
        table: botFills,
        ring: new TradeRingBuffer(options.fillsCapacity ?? 0),
        layout: new RowLayout(botFills, botFillsDef, null),
        pending: [],
        head: 0,
      };
    }
  }

  /** True when the simulator should report fills (botFills is on). */
  get recordsFills() {
    return this.#fills !== undefined;
  }

  /** Both sides of a trade, as two botFills rows (markout filled in later). */
  addFills(
    sim: SimulatedInstrument,
    trade: Trade,
    tradeId: string,
    maker: TradeParty,
    taker: TradeParty,
  ) {
    const fills = this.#fills;
    if (!fills) return;
    const takerBuys = trade.side === BookSide.BUY;
    const usd = usdPerUnit(sim.book.instrument);
    for (const [party, isMaker] of [
      [maker, true],
      [taker, false],
    ] as const) {
      const isBuy = isMaker ? !takerBuys : takerBuys;
      const { idx } = fills.layout;
      const key = botFillKey(tradeId, isMaker);
      const row = fills.layout.row();
      row[idx.id] = key;
      row[idx.tradeId] = tradeId;
      row[idx.ric] = sim.book.ric;
      row[idx.party] = party.id;
      row[idx.group] = party.group;
      row[idx.kind] = party.bot?.kind ?? "";
      row[idx.account] = party.account;
      row[idx.side] = isBuy ? Side.Buy : Side.Sell;
      row[idx.price] = trade.price;
      row[idx.quantity] = trade.size;
      row[idx.notionalUsd] = round(trade.price * trade.size * usd, 2);
      row[idx.liquidity] = isMaker ? Liquidity.Added : Liquidity.Removed;
      row[idx.timestamp] = trade.timestamp;
      fills.table.insert(row);
      const evicted = fills.ring.push(key);
      if (evicted !== undefined) fills.table.delete(evicted);
      fills.pending.push({
        key,
        row,
        sim,
        price: trade.price,
        sign: isBuy ? 1 : -1,
        at: trade.timestamp + this.markoutMs,
      });
    }
  }

  /** Fill in markouts that are due: mid now against the fill price. */
  #markouts(now: number) {
    const fills = this.#fills;
    if (!fills) return;
    const { pending } = fills;
    const markout = fills.layout.idx.markoutBps;
    while (fills.head < pending.length && pending[fills.head].at <= now) {
      const p = pending[fills.head++];
      const top = p.sim.book.topOfBook();
      const rowIdx = fills.table.rowIndexAtKey(p.key);
      if (rowIdx < 0 || !(top.bid > 0 && top.ask > 0)) continue;
      const mid = (top.bid + top.ask) / 2;
      p.row[markout] = round((p.sign * (mid - p.price) * 1e4) / p.price, 2);
      fills.table.update(rowIdx, p.row);
    }
    if (fills.head > 1024 && fills.head * 2 > pending.length) {
      pending.splice(0, fills.head);
      fills.head = 0;
    }
  }

  /** Static rows: every bot's parameters with their specs. */
  loadBotParams(sims: Iterable<SimulatedInstrument>) {
    for (const sim of sims) {
      for (const bot of sim.bots) this.publishBotParams(sim, bot);
    }
  }

  /** A bot was added or removed: rows for the instrument's bots now. */
  botsChanged(sim: SimulatedInstrument, removed?: Bot) {
    if (removed) {
      this.tables.bots.delete(removed.id);
      for (const spec of botKindDef(removed.kind).paramSpec)
        this.tables.botParams.delete(botParamKey(removed.id, spec.name));
      this.#rates.delete(removed.id);
    }
    const rateOf = botRates(sim);
    const now = this.#lastNow;
    for (const bot of sim.bots) {
      this.publishBotParams(sim, bot);
      this.#publishBot(sim, bot, rateOf(bot), now);
    }
  }

  /** One bot's parameter rows (after a change). */
  publishBotParams(sim: SimulatedInstrument, bot: Bot) {
    const { idx } = this.#botParams;
    const params = bot.params as Record<string, unknown>;
    const baseline = botBaseline(bot) as Record<string, unknown>;
    for (const spec of botKindDef(bot.kind).paramSpec) {
      const value = params[spec.name];
      const base = baseline[spec.name];
      const row = this.#botParams.row();
      row[idx.baseline] = base === undefined ? "" : String(base);
      row[idx.changed] = base !== value;
      row[idx.id] = botParamKey(bot.id, spec.name);
      row[idx.botId] = bot.id;
      row[idx.ric] = sim.book.ric;
      row[idx.kind] = bot.kind;
      row[idx.name] = spec.name;
      row[idx.type] = spec.type;
      row[idx.value] = value === undefined ? "" : String(value);
      row[idx.min] = spec.min ?? null;
      row[idx.max] = spec.max ?? null;
      row[idx.unit] = spec.unit ?? "";
      row[idx.description] = spec.description;
      row[idx.readOnly] = spec.readOnly === true;
      upsert(this.tables.botParams, row[idx.id] as string, row);
    }
  }

  /**
   * Fill in due markouts and take due samples; publish simBooks and bots if
   * the interval has passed (always on the first call). True when it did.
   */
  flush(instruments: Iterable<SimulatedInstrument>, now: number) {
    const sims = [...instruments];
    this.#lastNow = now;
    this.#markouts(now);
    const sampleAt = this.#samples?.history.due(now);
    const historyAt = this.#botHistory?.history.due(now);
    if (sampleAt !== undefined || historyAt !== undefined) {
      for (const sim of sims) {
        if (sampleAt !== undefined) this.#sample(sim, sampleAt);
        if (historyAt !== undefined) this.#sampleBots(sim, historyAt);
      }
    }
    if (this.intervalMs <= 0 || now < this.#nextAt) return false;
    this.#nextAt = now + this.intervalMs;
    for (const sim of sims) {
      this.#publishBook(sim, now);
      const rateOf = botRates(sim);
      for (const bot of sim.bots) this.#publishBot(sim, bot, rateOf(bot), now);
    }
    return true;
  }

  #sample(sim: SimulatedInstrument, time: number) {
    const samples = this.#samples;
    if (!samples) return;
    const { book, flow } = sim;
    const { idx } = samples.layout;
    const top = book.topOfBook();
    const twoSided = top.bid > 0 && top.ask > 0;
    const key = simSampleKey(book.ric, time);
    const row = samples.layout.row();
    row[idx.id] = key;
    row[idx.ric] = book.ric;
    row[idx.time] = time;
    row[idx.fair] = round(book.model.fairValue, 6);
    row[idx.walk] = round(book.model.walk, 6);
    row[idx.mid] = twoSided ? round((top.bid + top.ask) / 2, 6) : null;
    row[idx.bid] = top.bid > 0 ? top.bid : null;
    row[idx.ask] = top.ask > 0 ? top.ask : null;
    row[idx.impactOffsetBps] = round(book.model.impactOffsetBps, 2);
    let net = 0;
    const cols = idx as Record<string, number>;
    for (const group of OWNER_GROUPS) {
      row[cols[`${group}Buy`]] = flow.buy[group];
      row[cols[`${group}Sell`]] = flow.sell[group];
      row[cols[`${group}Net`]] = flow.buy[group] - flow.sell[group];
      net += flow.buy[group] - flow.sell[group];
    }
    row[idx.netFlow] = net;
    row[idx.mmInventory] = makerInventory(sim);
    flow.reset();
    samples.history.insert(book.ric, key, row);
  }

  #sampleBots(sim: SimulatedInstrument, time: number) {
    const history = this.#botHistory;
    if (!history) return;
    const { book } = sim;
    const usd = usdPerUnit(book.instrument);
    const mark = markOf(sim);
    const { idx } = history.layout;
    for (const bot of sim.bots) {
      const { ledger } = bot.port;
      const key = botHistoryKey(bot.id, time);
      const row = history.layout.row();
      row[idx.id] = key;
      row[idx.botId] = bot.id;
      row[idx.ric] = book.ric;
      row[idx.kind] = bot.kind;
      row[idx.time] = time;
      row[idx.position] = ledger.position;
      row[idx.totalPnlUsd] = round(ledger.totalPnl(mark) * usd, 2);
      row[idx.realisedPnlUsd] = round(ledger.realisedPnl * usd, 2);
      row[idx.volume] = ledger.volume;
      row[idx.orders] = ledger.orders;
      history.history.insert(bot.id, key, row);
    }
  }

  #publishBook(sim: SimulatedInstrument, now: number) {
    const { book, signals } = sim;
    const { idx } = this.#simBooks;
    const top = book.topOfBook();
    const fair = book.model.fairValue;
    const twoSided = top.bid > 0 && top.ask > 0;
    const mid = twoSided ? (top.bid + top.ask) / 2 : Number.NaN;
    const inventory = makerInventory(sim);
    // signals measure wall-clock time; the model runs timeScale faster
    const realised =
      (signals.volBpsPerSqrtSec / 1e4) *
      Math.sqrt(SECONDS_PER_YEAR / this.timeScale);
    const row = this.#simBooks.row();
    row[idx.ric] = book.ric;
    row[idx.phase] = book.phase;
    row[idx.haltReason] = book.haltReason;
    row[idx.fair] = round(fair, 6);
    row[idx.walk] = round(book.model.walk, 6);
    row[idx.impactOffsetBps] = round(book.model.impactOffsetBps, 2);
    row[idx.impactTodayBps] = round(book.model.impactTodayBps, 2);
    row[idx.impactK] = round(book.model.impact.k * 1e4, 3);
    row[idx.driftBpsPerHour] = book.model.driftBpsPerHour;
    row[idx.bandLow] = book.model.lowerBand;
    row[idx.bandHigh] = book.model.upperBand;
    row[idx.mid] = finite(mid, 6);
    row[idx.gapBps] = finite(((mid - fair) / fair) * 1e4, 2);
    row[idx.spreadBps] = finite(((top.ask - top.bid) / mid) * 1e4, 2);
    row[idx.volatility] = round(book.model.volatility, 4);
    row[idx.realisedVolatility] = round(realised, 4);
    row[idx.mmRate] = sim.mmRate;
    row[idx.takerRate] = sim.takerRate;
    row[idx.activity] = round(sim.activity, 3);
    row[idx.imbalance] = round(signals.imbalance, 3);
    row[idx.mmInventory] = inventory;
    row[idx.bots] = sim.bots.length;
    row[idx.tradeCount] = book.stats.tradeCount;
    row[idx.volume] = book.stats.volume;
    row[idx.updated] = now;
    upsert(this.tables.simBooks, book.ric, row);
    this.updates++;
  }

  #publishBot(sim: SimulatedInstrument, bot: Bot, rate: number, now: number) {
    const { idx } = this.#bots;
    const { ledger } = bot.port;
    const { book } = sim;
    const usd = usdPerUnit(book.instrument);
    const mark = markOf(sim);
    const unrealised = ledger.unrealisedPnl(mark);
    const resting = bot.port.restingQty();
    const extra = bot.extraStats?.() ?? {};

    const previous = this.#rates.get(bot.id);
    let effectiveRate = 0;
    if (previous && now > previous.at) {
      const latest =
        ((ledger.orders - previous.orders) * 1000) / (now - previous.at);
      effectiveRate = previous.rate + RATE_SMOOTHING * (latest - previous.rate);
    }
    this.#rates.set(bot.id, {
      orders: ledger.orders,
      at: now,
      rate: effectiveRate,
    });

    const row = this.#bots.row();
    row[idx.botId] = bot.id;
    row[idx.ric] = book.ric;
    row[idx.kind] = bot.kind;
    row[idx.localId] = bot.localId;
    row[idx.account] = bot.account;
    row[idx.position] = ledger.position;
    row[idx.avgPrice] =
      ledger.position === 0 ? null : round(ledger.avgPrice, 6);
    row[idx.positionUsd] = round(ledger.position * mark * usd, 2);
    row[idx.realisedPnlUsd] = round(ledger.realisedPnl * usd, 2);
    row[idx.unrealisedPnlUsd] = round(unrealised * usd, 2);
    row[idx.totalPnlUsd] = round((ledger.realisedPnl + unrealised) * usd, 2);
    row[idx.orders] = ledger.orders;
    row[idx.modifies] = ledger.modifies;
    row[idx.cancels] = ledger.cancels;
    row[idx.fills] = ledger.fills;
    row[idx.makerFills] = ledger.makerFills;
    row[idx.volume] = ledger.volume;
    row[idx.notionalUsd] = round(ledger.notional * usd, 2);
    row[idx.restingOrders] = bot.port.restingCount;
    row[idx.restingBidQty] = resting.bid;
    row[idx.restingAskQty] = resting.ask;
    row[idx.rate] = round(rate, 3);
    row[idx.effectiveRate] = round(effectiveRate, 3);
    row[idx.paused] = bot.port.paused;
    row[idx.skewTicks] = extra.skewTicks ?? null;
    row[idx.quotes] = extra.quotes ?? null;
    row[idx.updated] = now;
    upsert(this.tables.bots, bot.id, row);
    this.updates++;
  }
}
