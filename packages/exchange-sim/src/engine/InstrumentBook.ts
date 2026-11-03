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
  BookEventType,
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

/** One order-by-order (L3) change to the resting book. */
export interface BookEvent {
  /** Per-book event sequence: gap-free, starts at 1. */
  seq: number;
  type: BookEventType;
  orderId: string;
  /** Side of the resting order. */
  side: Side;
  price: number;
  /** ADD: shown size. EXECUTE: traded size. REDUCE / DELETE: size removed. */
  size: number;
  /** Open size left after the event (0 = gone from the book). */
  leaves: number;
  /** EXECUTE only; "" otherwise. */
  tradeId: string;
  timestamp: number;
}

/**
 * Receives the book's L3 events. The event object is reused: it is only
 * valid during the call.
 */
export interface BookEventSink {
  onBookEvent(book: InstrumentBook, event: Readonly<BookEvent>): void;
  /** The whole book was replaced (`restore`); no events describe the change. */
  onBookReset(book: InstrumentBook): void;
}

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
  /**
   * L3 event listener. Events are only built while one is set, so the
   * matching path costs nothing extra without it.
   */
  bookEvents: BookEventSink | undefined;
  readonly #sinks = new Map<string, FillSink>();
  #eventSeq = 0;
  readonly #event: BookEvent = {
    seq: 0,
    type: BookEventType.Add,
    orderId: "",
    side: Side.Buy,
    price: 0,
    size: 0,
    leaves: 0,
    tradeId: "",
    timestamp: 0,
  };
  /**
   * An amend's DELETE, held until we know the amend loses priority. It is
   * sent before the amend's first trade, or after the amend if it re-queued
   * without trading.
   */
  #pendingDelete: ILimitOrder | undefined;

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
    this.bookEvents?.onBookReset(this);
  }

  /** Last L3 event seq (0 = none yet). */
  get eventSeq() {
    return this.#eventSeq;
  }

  /** Every resting order, bids best first then asks best first, each level in time priority. */
  restingOrders(): ILimitOrder[] {
    const { bids, asks } = this.book.snapshot();
    const orders: ILimitOrder[] = [];
    for (const level of bids) orders.push(...level.orders);
    for (const level of asks) orders.push(...level.orders);
    return orders;
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
    if (sink || this.bookEvents) {
      const resting = this.book.order(options.id);
      if (sink && resting === undefined) this.#sinks.delete(options.id);
      if (resting && this.bookEvents) this.#emitAdd(resting);
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
    const before = this.bookEvents ? this.book.order(id) : undefined;
    this.#pendingDelete = before;
    const result = this.book.modify(id, update);
    this.#afterOp(result);
    if (this.#sinks.has(id) || before) {
      const after = this.book.order(id);
      if (after === undefined) this.#sinks.delete(id);
      if (before) this.#emitAmend(before, after, result);
    }
    return result;
  }

  cancel(id: string) {
    const before = this.bookEvents ? this.book.order(id) : undefined;
    const result = this.book.cancel(id);
    this.#sinks.delete(id);
    if (result) {
      this.events++;
      this.dirty = true;
      if (before) this.#emitRemoved(BookEventType.Delete, before, 0);
    }
    return result;
  }

  // ------------------------------------------------------------ L3 events

  #emit(
    type: BookEventType,
    orderId: string,
    side: BookSide,
    price: number,
    size: number,
    leaves: number,
    tradeId = "",
  ) {
    const sink = this.bookEvents;
    if (!sink) return;
    const event = this.#event;
    event.seq = ++this.#eventSeq;
    event.type = type;
    event.orderId = orderId;
    event.side = fromBookSide(side);
    event.price = price;
    event.size = size;
    event.leaves = leaves;
    event.tradeId = tradeId;
    event.timestamp = this.clock();
    sink.onBookEvent(this, event);
  }

  #emitAdd(order: ILimitOrder) {
    this.#emit(
      BookEventType.Add,
      order.id,
      order.side,
      order.price,
      order.size,
      order.size,
    );
  }

  /** DELETE (leaves 0) or REDUCE of `before`, down to `leaves`. */
  #emitRemoved(type: BookEventType, before: ILimitOrder, leaves: number) {
    this.#emit(
      type,
      before.id,
      before.side,
      before.price,
      before.size - leaves,
      leaves,
    );
  }

  #flushPendingDelete() {
    const pending = this.#pendingDelete;
    if (pending === undefined) return;
    this.#pendingDelete = undefined;
    this.#emitRemoved(BookEventType.Delete, pending, 0);
  }

  /**
   * A size decrease at the same price is a REDUCE (or a DELETE if nothing
   * is left). Losing priority is a DELETE, any EXECUTEs if the new price
   * crosses (the DELETE is sent before them, from #handleTrade), then an ADD
   * if the order still rests. A rejected amend sends nothing.
   */
  #emitAmend(
    before: ILimitOrder,
    after: ILimitOrder | undefined,
    result: IProcessOrder,
  ) {
    const deleteSent = this.#pendingDelete === undefined;
    if (result.err !== null && !deleteSent) {
      this.#pendingDelete = undefined;
      return;
    }
    if (deleteSent || result.priorityKept === false) {
      this.#flushPendingDelete();
      if (after) this.#emitAdd(after);
      return;
    }
    this.#pendingDelete = undefined;
    const leaves = after?.size ?? 0;
    if (leaves < before.size) {
      this.#emitRemoved(
        leaves > 0 ? BookEventType.Reduce : BookEventType.Delete,
        before,
        leaves,
      );
    }
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
    if (this.bookEvents) {
      // An amend that crossed: its DELETE goes before its executions.
      this.#flushPendingDelete();
      // onTrade fires after the whole operation, so the maker's size is final.
      const leaves = this.book.order(makerOrderId)?.size ?? 0;
      this.#emit(
        BookEventType.Execute,
        makerOrderId,
        trade.side === BookSide.BUY ? BookSide.SELL : BookSide.BUY,
        price,
        size,
        leaves,
        tradeId,
      );
    }
    this.#sinks.get(makerOrderId)?.onFill(makerOrderId, trade, true, tradeId);
    this.#sinks.get(takerOrderId)?.onFill(takerOrderId, trade, false, tradeId);
  }
}
