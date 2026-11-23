import { BookBuilder, type BookOrder, type Level } from "@heswell/book-model";
import { SIDES, Side } from "@heswell/trading-schemas";
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

/** The model level and own-order set each queue was built from. */
const builtFrom = new WeakMap<
  LadderQueue,
  { level: Level; ownOrderIds: ReadonlySet<string> | undefined }
>();

const toQueue = (
  level: Level,
  ownOrderIds: ReadonlySet<string> | undefined,
  old: LadderQueue | undefined,
): LadderQueue => {
  if (old) {
    const from = builtFrom.get(old);
    if (from?.level === level && from.ownOrderIds === ownOrderIds) return old;
  }
  const orders = level.orders.map<QueueOrder>((o) => ({
    orderId: o.orderId,
    size: o.size,
    entryTime: o.entryTime,
    priority: o.priority,
    own: ownOrderIds?.has(o.orderId) ?? false,
  }));
  let queue: LadderQueue;
  if (old && sameOrders(old.orders, orders)) {
    queue = old;
  } else {
    let ownRank: number | undefined;
    let ownAhead: number | undefined;
    let ahead = 0;
    for (let i = 0; i < orders.length; i++) {
      if (orders[i].own) {
        ownRank = i + 1;
        ownAhead = ahead;
        break;
      }
      ahead += orders[i].size;
    }
    queue = {
      side: level.side,
      price: level.price,
      orders,
      total: level.total,
      ownRank,
      ownAhead,
    };
  }
  builtFrom.set(queue, { level, ownOrderIds });
  return queue;
};

/**
 * The queues of every level of `book`, with the user's orders marked. A
 * queue that is unchanged since `previous` keeps its object, and if every
 * queue is unchanged `previous` itself is returned, so memoized ladder rows
 * only re-render where the queue moved.
 */
export const ladderQueuesOf = (
  book: BookBuilder,
  ownOrderIds: ReadonlySet<string> | undefined,
  previous?: LadderQueues,
): LadderQueues => {
  const queues = new Map<string, LadderQueue>();
  let reused = 0;
  for (const side of SIDES) {
    for (const level of book.levels(side)) {
      const key = ownOrdersKey(side, level.price);
      const old = previous?.get(key);
      const queue = toQueue(level, ownOrderIds, old);
      if (queue === old) reused++;
      queues.set(key, queue);
    }
  }
  return previous && reused === queues.size && previous.size === reused
    ? previous
    : queues;
};

const isBookSide = (side: unknown): side is Side =>
  side === Side.Buy || side === Side.Sell;

/** `bookOrders` rows of one side or the other as model orders. */
const toBookOrders = (rows: readonly BookOrderRow[]): BookOrder[] => {
  const orders: BookOrder[] = [];
  for (const row of rows) {
    if (!isBookSide(row.side)) continue;
    orders.push({
      orderId: row.orderId,
      side: row.side,
      price: row.price,
      size: row.size,
      entryTime: row.entryTime,
      priority: row.priority,
    });
  }
  return orders;
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
): LadderQueues => {
  const book = new BookBuilder();
  book.reset(toBookOrders(rows));
  return ladderQueuesOf(book, ownOrderIds, previous);
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
  /**
   * The instrument has more resting orders than `maxOrders`: the rest were
   * not loaded, so queues may be incomplete.
   */
  truncated: boolean;
  loaded: boolean;
}

const EMPTY: LadderQueues = new Map();

/**
 * The order-by-order (L3) queue of every price level of one instrument,
 * from EXCHANGE `bookOrders` (rebuilt with a `BookBuilder` from
 * `@heswell/book-model`), with the user's orders marked. The table is
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
  const { rows, size, loaded } = useDataSourceRows(dataSource, {
    enabled: active,
    filter: ric ? `ric = ${filterString(ric)}` : "",
    rowCount: maxOrders,
  });
  const model = useRef<{ ric: string; book: BookBuilder } | undefined>(
    undefined,
  );
  const previous = useRef<LadderQueues>(EMPTY);
  return useMemo(() => {
    if (!active || !ric) {
      model.current = undefined;
      previous.current = EMPTY;
      return { queues: EMPTY, orderCount: 0, truncated: false, loaded: false };
    }
    if (model.current?.ric !== ric) {
      model.current = { ric, book: new BookBuilder() };
      previous.current = EMPTY;
    }
    const { book } = model.current;
    const mine = rows.filter((row) => row.ric === ric);
    // snapshot-only feed: the diff keeps unchanged levels' objects
    book.reset(toBookOrders(mine as unknown as BookOrderRow[]));
    const queues = ladderQueuesOf(book, ownOrderIds, previous.current);
    previous.current = queues;
    return {
      queues,
      orderCount: book.orderCount,
      truncated: size > maxOrders,
      loaded,
    };
  }, [active, rows, size, maxOrders, ric, ownOrderIds, loaded]);
};
