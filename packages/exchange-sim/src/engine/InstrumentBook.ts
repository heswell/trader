import {
  type IProcessOrder,
  type LimitOrderOptions,
  type MarketOrderOptions,
  OrderBook,
  type OrderUpdate,
  Side as BookSide,
  type Trade,
} from "@heswell/hft-limit-order-book";
import {
  Side,
  tickScheduleOf,
  type TickSchedule,
  TradingPhase,
} from "@heswell/trading-schemas";
import type { InstrumentDef } from "../reference/instruments";
import type { Clock } from "../util/clock";
import type { ILimitOrder } from "./persistence";
import { PriceModel } from "./PriceModel";

export const toBookSide = (side: Side) =>
  side === Side.Buy ? BookSide.BUY : BookSide.SELL;
export const fromBookSide = (side: BookSide): Side =>
  side === BookSide.BUY ? Side.Buy : Side.Sell;

/** Receives executions for orders it placed (bots, gateway). */
export interface FillSink {
  /** @param tradeId exchange-wide trade id (as published in the trades table) */
  onFill(
    orderId: string,
    trade: Trade,
    isMaker: boolean,
    tradeId: string,
  ): void;
}

export interface SessionStats {
  last: number;
  lastSize: number;
  open: number;
  high: number;
  low: number;
  volume: number;
  turnover: number;
  tradeCount: number;
}

/** Called for every trade before fills are routed; returns the exchange trade id. */
export type BookTradeListener = (book: InstrumentBook, trade: Trade) => string;

/**
 * One live order book plus the state that hangs off it: fair-value model,
 * trading phase, session statistics and fill routing. All order entry for
 * the instrument (bots and gateway) goes through this class so that event
 * counting and dirty tracking are in one place.
 */
export class InstrumentBook {
  /** Replaced (never mutated in place) by `restore`. */
  book: OrderBook;
  readonly schedule: TickSchedule;
  readonly model: PriceModel;
  phase: TradingPhase = TradingPhase.Continuous;
  haltReason = "";
  readonly stats: SessionStats = {
    last: 0,
    lastSize: 0,
    open: 0,
    high: 0,
    low: 0,
    volume: 0,
    turnover: 0,
    tradeCount: 0,
  };
  /** Book operations + trades since creation. */
  events = 0;
  /** Set on any change; cleared by the publisher. */
  dirty = true;
  readonly #sinks = new Map<string, FillSink>();

  constructor(
    readonly instrument: InstrumentDef,
    volatility: number,
    bandPct: number,
    readonly clock: Clock,
    private readonly onTradeListener?: BookTradeListener,
  ) {
    this.schedule = tickScheduleOf(instrument);
    this.model = new PriceModel(
      instrument.refPrice,
      this.schedule,
      volatility,
      bandPct,
    );
    this.book = new OrderBook({
      clock,
      onTrade: (trade) => this.#handleTrade(trade),
    });
  }

  get ric() {
    return this.instrument.ric;
  }

  /**
   * Replace the order book with `orders` (resting limit orders, each queue in
   * time priority) owned by `sink`, e.g. restored gateway orders. Call
   * before any other order entry: existing orders are dropped.
   */
  restore(
    orders: readonly ILimitOrder[],
    sink: FillSink,
    { seq = 0, stats }: { seq?: number; stats?: SessionStats } = {},
  ) {
    type Level = { price: number; orders: ILimitOrder[] };
    const levels = {
      bids: new Map<number, Level>(),
      asks: new Map<number, Level>(),
    };
    for (const order of orders) {
      const side = order.side === BookSide.BUY ? levels.bids : levels.asks;
      let level = side.get(order.price);
      if (!level) {
        level = { price: order.price, orders: [] };
        side.set(order.price, level);
      }
      level.orders.push(order);
    }
    const sorted = (map: Map<number, Level>, dir: number) =>
      [...map.values()].sort((a, b) => dir * (a.price - b.price));
    this.book = new OrderBook({
      clock: this.clock,
      onTrade: (trade) => this.#handleTrade(trade),
      snapshot: {
        bids: sorted(levels.bids, -1),
        asks: sorted(levels.asks, 1),
        stopBook: { bids: [], asks: [] },
        ts: this.clock(),
        lastOp: 0,
        seq,
      },
    });
    this.#sinks.clear();
    for (const order of orders) this.#sinks.set(order.id, sink);
    if (stats) Object.assign(this.stats, stats);
    this.dirty = true;
  }

  get seq() {
    return this.book.seq;
  }

  get isHalted() {
    return this.phase === TradingPhase.Halted;
  }

  /** Best bid / ask (0 when that side is empty). */
  topOfBook() {
    const [asks, bids] = this.book.depthDetailed(1);
    return {
      bid: bids[0]?.price ?? 0,
      bidSize: bids[0]?.size ?? 0,
      ask: asks[0]?.price ?? 0,
      askSize: asks[0]?.size ?? 0,
    };
  }

  limit(options: LimitOrderOptions, sink?: FillSink): IProcessOrder {
    if (sink) this.#sinks.set(options.id, sink);
    const result = this.book.limit(options);
    this.#afterOp(result);
    if (sink && this.book.order(options.id) === undefined) {
      this.#sinks.delete(options.id);
    }
    return result;
  }

  market(options: MarketOrderOptions & { id: string }, sink?: FillSink) {
    if (sink) this.#sinks.set(options.id, sink);
    const result = this.book.market(options);
    this.#afterOp(result);
    if (sink) this.#sinks.delete(options.id);
    return result;
  }

  /**
   * Amend a resting order. A size decrease at the same price keeps time
   * priority (`result.priorityKept`); a price change or size increase
   * re-queues it at the back of the level and may trade if it crosses.
   */
  modify(id: string, update: OrderUpdate) {
    const result = this.book.modify(id, update);
    this.#afterOp(result);
    if (this.#sinks.has(id) && this.book.order(id) === undefined) {
      this.#sinks.delete(id);
    }
    return result;
  }

  cancel(id: string) {
    const result = this.book.cancel(id);
    this.#sinks.delete(id);
    if (result) {
      this.events++;
      this.dirty = true;
    }
    return result;
  }

  #afterOp(result: IProcessOrder) {
    this.events++;
    this.dirty = true;
    const done = result.done;
    for (let i = 0; i < done.length; i++) this.#sinks.delete(done[i].id);
  }

  #handleTrade(trade: Trade) {
    const stats = this.stats;
    const { price, size } = trade;
    if (stats.tradeCount === 0) {
      stats.open = stats.high = stats.low = price;
    } else {
      if (price > stats.high) stats.high = price;
      if (price < stats.low) stats.low = price;
    }
    stats.last = price;
    stats.lastSize = size;
    stats.volume += size;
    stats.turnover += price * size;
    stats.tradeCount++;
    this.events++;
    this.dirty = true;
    const tradeId =
      this.onTradeListener?.(this, trade) ?? `${this.ric}:${trade.tradeId}`;
    const { makerOrderId, takerOrderId } = trade;
    this.#sinks.get(makerOrderId)?.onFill(makerOrderId, trade, true, tradeId);
    this.#sinks.get(takerOrderId)?.onFill(takerOrderId, trade, false, tradeId);
  }
}
