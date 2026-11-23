import type { BookEventType, Side } from "@heswell/trading-schemas";

/** One resting order (EXCHANGE `bookOrders` row). Never mutated: a change replaces it. */
export interface BookOrder {
  /** Exchange order id. */
  readonly orderId: string;
  readonly side: Side;
  readonly price: number;
  /** Open (resting) size. */
  readonly size: number;
  /** When the order took its place in the queue (epoch ms). */
  readonly entryTime: number;
  /** Queue order at its price: lower is nearer the front. */
  readonly priority: number;
}

/** One order-by-order change (EXCHANGE `bookEvents` row, or the engine's event). */
export interface BookEvent {
  /** Per-instrument event sequence: gap-free, starts at 1. */
  readonly seq: number;
  readonly type: BookEventType;
  /** "" for RESET. */
  readonly orderId: string;
  /** Side of the resting order; "" for RESET. */
  readonly side: Side | "";
  /** 0 for RESET. */
  readonly price: number;
  /** ADD: shown size. EXECUTE: traded size. REDUCE / DELETE: size removed. RESET: 0. */
  readonly size: number;
  /** Open size left after the event (0 = gone from the book). */
  readonly leaves: number;
  /** EXECUTE only; "" otherwise. */
  readonly tradeId: string;
  /** Epoch ms. */
  readonly timestamp: number;
}

/**
 * The queue at one side and price. A level object is replaced only when its
 * queue changes, so it can be compared by identity.
 */
export interface Level {
  readonly side: Side;
  readonly price: number;
  /** Sum of the orders' sizes. */
  readonly total: number;
  /** Number of orders. */
  readonly count: number;
  /** Front of the queue first. */
  readonly orders: readonly BookOrder[];
}

/** Where one order rests. */
export interface OrderPosition {
  readonly order: BookOrder;
  readonly level: Level;
  /** 1-based place in the queue. */
  readonly rank: number;
  /** Size ahead of the order. */
  readonly ahead: number;
}

/** A side and price, for a level that has gone. */
export interface LevelKey {
  readonly side: Side;
  readonly price: number;
}

/** What one `reset` or `apply` changed. */
export interface BookChange {
  /** New or changed levels (their new objects). */
  readonly levels: readonly Level[];
  /** Levels that are now empty. */
  readonly removed: readonly LevelKey[];
  /** Orders added, changed or removed. */
  readonly orderIds: readonly string[];
}

/**
 * - `empty`: never loaded.
 * - `live`: loaded, and every event applied so far was in sequence.
 * - `stale`: an event was missing or did not match the book, or a RESET
 *   replaced the book; `reset` to resync.
 */
export type BookStatus = "empty" | "live" | "stale";
