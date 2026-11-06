import { Side } from "@heswell/trading-schemas";
import { useMemo, useRef } from "react";
import { useDataSourceRows } from "../data/useDataSourceRows";
import { useTradingDataSource } from "../data/useTradingDataSource";
import { filterString } from "../utils/filters";
import { ownOrdersKey } from "./useOwnWorkingOrders";

/** One resting order in a price level's queue (EXCHANGE `bookOrders`). */
export interface QueueOrder {
  /** Exchange order id. */
  orderId: string;
  size: number;
  /** When the order took its place in the queue (epoch ms). */
  entryTime: number;
  /** Queue order key: lower is nearer the front. */
  priority: number;
  /** One of the user's orders. */
  own: boolean;
}

/** The queue of resting orders at one side and price. */
export interface LadderQueue {
  side: Side;
  price: number;
  /** Front of the queue first. */
  orders: readonly QueueOrder[];
  /** Sum of the orders' sizes. */
  total: number;
  /** 1-based position of the user's first order in the queue, if any. */
  ownRank?: number;
  /** Size ahead of the user's first order. */
  ownAhead?: number;
}

/** Queues keyed by `ownOrdersKey(side, price)`. */
export type LadderQueues = ReadonlyMap<string, LadderQueue>;

export interface BookOrderRow {
  orderId: string;
  side: Side | string;
  price: number;
  size: number;
  entryTime: number;
  priority: number;
}

const sameOrders = (a: readonly QueueOrder[], b: readonly QueueOrder[]) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.orderId !== y.orderId || x.size !== y.size || x.own !== y.own) {
      return false;
    }
  }
  return true;
};

/**
 * Group `bookOrders` rows into per-level queues, front first. A level whose
 * orders are unchanged keeps its object from `previous`, so memoized ladder
 * rows only re-render where the queue moved.
 */
export const buildLadderQueues = (
  rows: readonly BookOrderRow[],
  ownOrderIds: ReadonlySet<string> | undefined,
  previous?: LadderQueues,
): Map<string, LadderQueue> => {
  const byLevel = new Map<
    string,
    { side: Side; price: number; orders: QueueOrder[] }
  >();
  for (const row of rows) {
    if (row.side !== Side.Buy && row.side !== Side.Sell) continue;
    const key = ownOrdersKey(row.side, row.price);
    let level = byLevel.get(key);
    if (!level) {
      level = { side: row.side, price: row.price, orders: [] };
      byLevel.set(key, level);
    }
    level.orders.push({
      orderId: row.orderId,
      size: row.size,
      entryTime: row.entryTime,
      priority: row.priority,
      own: ownOrderIds?.has(row.orderId) ?? false,
    });
  }
  const queues = new Map<string, LadderQueue>();
  for (const [key, { side, price, orders }] of byLevel) {
    orders.sort((a, b) => a.priority - b.priority);
    const old = previous?.get(key);
    if (old && sameOrders(old.orders, orders)) {
      queues.set(key, old);
      continue;
    }
    let total = 0;
    let ownRank: number | undefined;
    let ownAhead: number | undefined;
    for (let i = 0; i < orders.length; i++) {
      if (ownRank === undefined && orders[i].own) {
        ownRank = i + 1;
        ownAhead = total;
      }
      total += orders[i].size;
    }
    queues.set(key, { side, price, orders, total, ownRank, ownAhead });
  }
  return queues;
};

export interface BookQueueOptions {
  /** Subscribe (default true); false releases the subscription. */
  enabled?: boolean;
  /** Exchange order ids of the user's orders (see useOwnExchangeOrderIds). */
  ownOrderIds?: ReadonlySet<string>;
  /** Rows to subscribe to. Default 2,000. */
  maxOrders?: number;
}

export interface BookQueueState {
  queues: LadderQueues;
  /** Resting orders received for the instrument. */
  orderCount: number;
  loaded: boolean;
}

const EMPTY: LadderQueues = new Map();

/**
 * The order-by-order (L3) queue of every price level of one instrument,
 * from EXCHANGE `bookOrders`, with the user's orders marked. The table is
 * empty when the server runs with `exchangeSim.bookOrders=0`.
 */
export const useBookQueue = (
  ric: string | undefined,
  { enabled = true, ownOrderIds, maxOrders = 2_000 }: BookQueueOptions = {},
): BookQueueState => {
  const dataSource = useTradingDataSource("bookOrders", {
    columns: [
      "orderId",
      "ric",
      "side",
      "price",
      "size",
      "entryTime",
      "priority",
    ],
  });
  const active = enabled && !!ric;
  const { rows, loaded } = useDataSourceRows(dataSource, {
    enabled: active,
    filter: ric ? `ric = ${filterString(ric)}` : "",
    rowCount: maxOrders,
  });
  const previous = useRef<LadderQueues>(EMPTY);
  return useMemo(() => {
    if (!active) {
      previous.current = EMPTY;
      return { queues: EMPTY, orderCount: 0, loaded: false };
    }
    const mine = rows.filter((row) => row.ric === ric);
    const queues = buildLadderQueues(
      mine as unknown as BookOrderRow[],
      ownOrderIds,
      previous.current,
    );
    previous.current = queues;
    return { queues, orderCount: mine.length, loaded };
  }, [active, rows, ric, ownOrderIds, loaded]);
};
