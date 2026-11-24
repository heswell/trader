import {
  BookBuilder,
  type BookEvent,
  BookFeed,
  type BookFeedSource,
  type BookOrder,
  type Level,
  type QueueActivity,
  type SnapshotOrder,
} from "@heswell/book-model";
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
  /**
   * Follow the `bookEvents` tape too, so `activity` reports fills and
   * cancels ahead of the user's orders. Falls back to snapshots when the
   * server's tape is off, or when the book is `truncated` (a partial
   * snapshot never matches its marker). Default false.
   */
  events?: boolean;
  /** Newest `bookEvents` rows subscribed to in event mode. Default 100. */
  eventWindow?: number;
}

/** Where the queues come from: see `BookFeedSource` (`snapshot` without `events`). */
export type BookQueueSource = BookFeedSource;

export interface BookQueueState {
  queues: LadderQueues;
  /** Resting orders received for the instrument. */
  orderCount: number;
  /**
   * Resting orders the instrument has: the `bookStatus` marker's `orders`,
   * or the `bookOrders` viewport size until the marker arrives.
   */
  restingOrders: number;
  /**
   * The instrument has more resting orders than `maxOrders`: the rest were
   * not loaded, so queues may be incomplete.
   */
  truncated: boolean;
  loaded: boolean;
  /**
   * Event mode only: what happened ahead of each of the user's orders since
   * it was first seen, by exchange order id. Empty unless `source` is
   * `events`.
   */
  activity: ReadonlyMap<string, QueueActivity>;
  /** `events` once the tape keeps the book up to date. */
  source: BookQueueSource;
}

const EMPTY: LadderQueues = new Map();
const NO_ACTIVITY: ReadonlyMap<string, QueueActivity> = new Map();

const ORDER_COLUMNS = [
  "orderId",
  "ric",
  "side",
  "price",
  "size",
  "entryTime",
  "priority",
  "seq",
];
const STATUS_COLUMNS = ["ric", "seq", "orders"];
const EVENT_COLUMNS = [
  "id",
  "ric",
  "seq",
  "type",
  "orderId",
  "side",
  "price",
  "size",
  "leaves",
  "tradeId",
  "timestamp",
];

/** `bookOrders` rows with their seq, for BookFeed. */
const toSnapshotOrders = (
  rows: readonly (BookOrderRow & { seq?: number })[],
): SnapshotOrder[] => {
  const orders: SnapshotOrder[] = [];
  for (const row of rows) {
    if (!isBookSide(row.side)) continue;
    orders.push({
      orderId: row.orderId,
      side: row.side,
      price: row.price,
      size: row.size,
      entryTime: row.entryTime,
      priority: row.priority,
      seq: row.seq ?? 0,
    });
  }
  return orders;
};

/** Tape rows of `ric` newer than `after`, as model events. */
function* tapeEvents(
  rows: readonly Record<string, unknown>[],
  ric: string,
  after: number,
): Generator<BookEvent> {
  for (const row of rows) {
    const seq = row.seq as number;
    if (row.ric !== ric || seq <= after) continue;
    yield {
      seq,
      type: row.type as BookEvent["type"],
      orderId: String(row.orderId ?? ""),
      side: (row.side ?? "") as BookEvent["side"],
      price: row.price as number,
      size: row.size as number,
      leaves: row.leaves as number,
      tradeId: String(row.tradeId ?? ""),
      timestamp: row.timestamp as number,
    };
  }
}

/** Start or stop tracking so exactly `ids` are tracked. */
const syncTracked = (
  book: BookBuilder,
  ids: ReadonlySet<string> | undefined,
) => {
  for (const id of [...book.tracked()]) if (!ids?.has(id)) book.untrack(id);
  if (ids) for (const id of ids) book.track(id);
};

const activityOf = (
  book: BookBuilder,
  previous: ReadonlyMap<string, QueueActivity>,
) => {
  const activity = new Map<string, QueueActivity>();
  let same = true;
  for (const id of book.tracked()) {
    const a = book.activity(id);
    if (!a) continue;
    activity.set(id, a);
    if (previous.get(id) !== a) same = false;
  }
  if (same && activity.size === previous.size) return previous;
  return activity.size === 0 ? NO_ACTIVITY : activity;
};

interface Model {
  ric: string;
  events: boolean;
  feed: BookFeed;
  /** Queues while the feed waits for a consistent snapshot. */
  fallback: BookBuilder;
}

/**
 * The order-by-order (L3) queue of every price level of one instrument,
 * from EXCHANGE `bookOrders` (rebuilt with `@heswell/book-model`), with the
 * user's orders marked. With `events`, the `bookEvents` tape keeps the book
 * up to date between snapshots (`BookFeed`) and `activity` says what
 * happened ahead of the user's orders. The table is empty when the server
 * runs with `exchangeSim.bookOrders=0`.
 */
export const useBookQueue = (
  ric: string | undefined,
  {
    enabled = true,
    ownOrderIds,
    maxOrders = 2_000,
    events = false,
    eventWindow = 100,
  }: BookQueueOptions = {},
): BookQueueState => {
  const dataSource = useTradingDataSource("bookOrders", {
    columns: ORDER_COLUMNS,
  });
  const statusSource = useTradingDataSource("bookStatus", {
    columns: STATUS_COLUMNS,
  });
  const eventSource = useTradingDataSource("bookEvents", {
    columns: EVENT_COLUMNS,
    sort: { sortDefs: [{ column: "seq", sortType: "D" }] },
  });
  const active = enabled && !!ric;
  const filter = ric ? `ric = ${filterString(ric)}` : "";
  const { rows, size, loaded } = useDataSourceRows(dataSource, {
    enabled: active,
    filter,
    rowCount: maxOrders,
  });
  // the marker's order count says whether the book fits in maxOrders, so
  // it is read in either mode
  const { rows: statusRows } = useDataSourceRows(statusSource, {
    enabled: active,
    filter,
    rowCount: 1,
  });
  const status = ric ? statusRows.find((row) => row.ric === ric) : undefined;
  const restingOrders =
    typeof status?.orders === "number" ? status.orders : size;
  const truncated = restingOrders > maxOrders;
  // a truncated snapshot never matches its marker, so the feed could never
  // go live: stay on snapshots and don't pay for the tape
  const followTape = events && !truncated;
  const { rows: eventRows } = useDataSourceRows(eventSource, {
    enabled: active && followTape,
    filter,
    rowCount: eventWindow,
  });
  const model = useRef<Model | undefined>(undefined);
  const previous = useRef<LadderQueues>(EMPTY);
  const previousActivity = useRef(NO_ACTIVITY);
  return useMemo(() => {
    if (!active || !ric) {
      model.current = undefined;
      previous.current = EMPTY;
      previousActivity.current = NO_ACTIVITY;
      return {
        queues: EMPTY,
        orderCount: 0,
        restingOrders: 0,
        truncated: false,
        loaded: false,
        activity: NO_ACTIVITY,
        source: "waiting",
      };
    }
    if (model.current?.ric !== ric || model.current.events !== followTape) {
      model.current = {
        ric,
        events: followTape,
        feed: new BookFeed(),
        fallback: new BookBuilder(),
      };
      previous.current = EMPTY;
      previousActivity.current = NO_ACTIVITY;
    }
    const { feed, fallback } = model.current;
    const mine = rows.filter(
      (row) => row.ric === ric,
    ) as unknown as BookOrderRow[];
    let book: BookBuilder = feed.book;
    let source: BookQueueSource = "snapshot";
    let activity = NO_ACTIVITY;
    if (followTape) {
      syncTracked(feed.book, ownOrderIds);
      const live = feed.book.status === "live";
      feed.events(tapeEvents(eventRows, ric, live ? feed.book.seq : 0));
      feed.snapshot(
        toSnapshotOrders(mine),
        status && {
          seq: status.seq as number,
          orders: status.orders as number,
        },
      );
      source = feed.source;
      if (source === "waiting") {
        // until rows and marker agree, show the rows as they are
        fallback.reset(toBookOrders(mine));
        book = fallback;
      }
      // counts mean something only while events drive the book
      if (source === "events") {
        activity = activityOf(feed.book, previousActivity.current);
      }
      previousActivity.current = activity;
    } else {
      // snapshot-only feed: the diff keeps unchanged levels' objects
      feed.book.reset(toBookOrders(mine));
    }
    const queues = ladderQueuesOf(book, ownOrderIds, previous.current);
    previous.current = queues;
    return {
      queues,
      orderCount: book.orderCount,
      restingOrders,
      truncated,
      loaded,
      activity,
      source,
    };
  }, [
    active,
    rows,
    ric,
    ownOrderIds,
    loaded,
    followTape,
    status,
    restingOrders,
    truncated,
    eventRows,
  ]);
};
