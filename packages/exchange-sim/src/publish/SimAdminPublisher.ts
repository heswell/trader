import {
  botParamKey,
  BotType,
  botParams as botParamsDef,
  bots as botsDef,
  simBooks as simBooksDef,
} from "@heswell/trading-schemas";
import type { Bot } from "../engine/bots/Bot";
import { botKindDef } from "../engine/bots/roster";
import type { SimulatedInstrument } from "../engine/ExchangeSimulator";
import { SECONDS_PER_YEAR } from "../engine/PriceModel";
import { type PublishTable, RowLayout, type RowValue, round } from "./rows";

export interface SimAdminTables {
  simBooks: PublishTable;
  bots: PublishTable;
  botParams: PublishTable;
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
  /** Orders count and time at the previous publish, per bot. */
  readonly #rates = new Map<
    string,
    { orders: number; at: number; rate: number }
  >();
  #nextAt = Number.NEGATIVE_INFINITY;
  updates = 0;

  constructor(
    readonly tables: SimAdminTables,
    readonly intervalMs: number,
    /** Simulated seconds per wall-clock second (config timeScale). */
    readonly timeScale: number,
  ) {
    this.#simBooks = new RowLayout(tables.simBooks, simBooksDef, null);
    this.#bots = new RowLayout(tables.bots, botsDef, null);
    this.#botParams = new RowLayout(tables.botParams, botParamsDef, null);
  }

  /** Static rows: every bot's parameters with their specs. */
  loadBotParams(sims: Iterable<SimulatedInstrument>) {
    const { idx } = this.#botParams;
    for (const sim of sims) {
      for (const bot of sim.bots) {
        const params = bot.params as Record<string, unknown>;
        for (const spec of botKindDef(bot.kind).paramSpec) {
          const value = params[spec.name];
          const row = this.#botParams.row();
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
    }
  }

  /** Publish if the interval has passed (always on the first call). */
  flush(sims: Iterable<SimulatedInstrument>, now: number) {
    if (this.intervalMs <= 0 || now < this.#nextAt) return false;
    this.#nextAt = now + this.intervalMs;
    for (const sim of sims) {
      this.#publishBook(sim, now);
      const rateOf = botRates(sim);
      for (const bot of sim.bots) this.#publishBot(sim, bot, rateOf(bot), now);
    }
    return true;
  }

  #publishBook(sim: SimulatedInstrument, now: number) {
    const { book, signals } = sim;
    const { idx } = this.#simBooks;
    const top = book.topOfBook();
    const fair = book.model.fairValue;
    const twoSided = top.bid > 0 && top.ask > 0;
    const mid = twoSided ? (top.bid + top.ask) / 2 : Number.NaN;
    let inventory = 0;
    for (const bot of sim.bots) {
      if (botKindDef(bot.kind).rateGroup === BotType.MarketMaker)
        inventory += bot.port.ledger.position;
    }
    // signals measure wall-clock time; the model runs timeScale faster
    const realised =
      (signals.volBpsPerSqrtSec / 1e4) *
      Math.sqrt(SECONDS_PER_YEAR / this.timeScale);
    const row = this.#simBooks.row();
    row[idx.ric] = book.ric;
    row[idx.phase] = book.phase;
    row[idx.haltReason] = book.haltReason;
    row[idx.fair] = round(fair, 6);
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
    const usd = book.instrument.usdPerPriceUnit;
    const top = book.topOfBook();
    const mark =
      top.bid > 0 && top.ask > 0
        ? (top.bid + top.ask) / 2
        : book.model.fairValue;
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
    row[idx.skewTicks] = extra.skewTicks ?? null;
    row[idx.quotes] = extra.quotes ?? null;
    row[idx.updated] = now;
    upsert(this.tables.bots, bot.id, row);
    this.updates++;
  }
}
