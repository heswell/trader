import { OrdStatus } from "@heswell/trading-schemas";
import {
  orderEventKindForStatus,
  type TradingOrderEvent,
} from "./tradingOrderEvents";

type Row = Record<string, unknown>;

const num = (v: unknown) => (typeof v === "number" ? v : undefined);
const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);

/** TradingOrderEvent fields from a parentOrders row. */
export const orderEventFromParentOrder = (
  row: Row,
  kind = orderEventKindForStatus(row.status),
): TradingOrderEvent | undefined =>
  kind && {
    kind,
    orderId: str(row.orderId),
    clOrdId: str(row.clOrdId),
    ric: str(row.ric),
    side: str(row.side),
    quantity: num(row.quantity),
    price: num(row.price),
    account: str(row.account),
    status: str(row.status),
    reason: str(row.rejectReason),
    text: str(row.text),
    cumQty: num(row.cumQty),
    avgPx: num(row.avgPx),
    currency: str(row.currency),
    source: "stream",
  };

/** TradingOrderEvent for a fills row. */
export const orderEventFromFill = (row: Row): TradingOrderEvent => ({
  kind: "fill",
  execId: str(row.execId),
  orderId: str(row.orderId),
  ric: str(row.ric),
  side: str(row.side),
  account: str(row.account),
  fillQty: num(row.quantity),
  fillPx: num(row.price),
  currency: str(row.currency),
  source: "stream",
});

/**
 * Turns parentOrders updates into order events. The first batch is the
 * snapshot and is recorded silently; after that a status (or version, for
 * amends) change on a known order, or an order not seen before that was
 * updated after the snapshot, produces an event. Subscribe sorted by
 * lastUpdate descending so recently updated orders stay in range.
 */
export class ParentOrderEventTracker {
  #orders = new Map<string, { status: unknown; version: unknown }>();
  #watermark: number | undefined;

  /**
   * Process a batch of rows; returns the events it implies. `size` is the
   * viewport size, if the update carries it (a size-only first update is not
   * taken as the snapshot unless the table is empty).
   */
  update(rows: readonly Row[], size?: number): TradingOrderEvent[] {
    const events: TradingOrderEvent[] = [];
    const snapshot = this.#watermark === undefined;
    if (snapshot && rows.length === 0 && size !== 0) return events;
    if (snapshot) {
      this.#watermark = Math.max(0, ...rows.map((r) => num(r.lastUpdate) ?? 0));
    }
    for (const row of rows) {
      const orderId = str(row.orderId);
      if (!orderId) continue;
      const previous = this.#orders.get(orderId);
      this.#orders.set(orderId, { status: row.status, version: row.version });
      if (snapshot) continue;
      if (previous) {
        const statusChanged = previous.status !== row.status;
        const amended =
          row.status === OrdStatus.Replaced && previous.version !== row.version;
        if (!statusChanged && !amended) continue;
      } else if ((num(row.lastUpdate) ?? 0) < (this.#watermark ?? 0)) {
        continue;
      }
      const event = orderEventFromParentOrder(row);
      if (event) events.push(event);
    }
    return events;
  }

  reset() {
    this.#orders.clear();
    this.#watermark = undefined;
  }
}

/**
 * Turns fills updates into fill events: rows in the first batch (snapshot)
 * and fills older than it are ignored. Subscribe sorted by timestamp
 * descending.
 */
export class FillEventTracker {
  #seen = new Set<string>();
  #watermark: number | undefined;

  update(rows: readonly Row[], size?: number): TradingOrderEvent[] {
    const events: TradingOrderEvent[] = [];
    const snapshot = this.#watermark === undefined;
    if (snapshot && rows.length === 0 && size !== 0) return events;
    if (snapshot) {
      this.#watermark = Math.max(0, ...rows.map((r) => num(r.timestamp) ?? 0));
    }
    for (const row of rows) {
      const execId = str(row.execId);
      if (!execId || this.#seen.has(execId)) continue;
      this.#seen.add(execId);
      if (snapshot || (num(row.timestamp) ?? 0) < (this.#watermark ?? 0)) {
        continue;
      }
      events.push(orderEventFromFill(row));
    }
    if (this.#seen.size > 10_000) this.#seen.clear();
    return events;
  }

  reset() {
    this.#seen.clear();
    this.#watermark = undefined;
  }
}
