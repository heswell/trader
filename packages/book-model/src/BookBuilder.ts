import { BookEventType, Side } from "@heswell/trading-schemas";
import type {
  BookChange,
  BookEvent,
  BookOrder,
  BookStatus,
  Level,
  LevelKey,
  OrderPosition,
  QueueActivity,
} from "./types";

/** Mutable state behind one published `Level`. */
interface LevelState {
  readonly side: Side;
  readonly price: number;
  /** Sorted by priority, front first. */
  readonly orders: BookOrder[];
  /** The last published object; undefined until the first commit. */
  level: Level | undefined;
}

interface SideState {
  readonly levels: Map<number, LevelState>;
  /** Best first; undefined when a level was added or removed. */
  prices: number[] | undefined;
  /** Published levels, best first; undefined when any level changed. */
  sorted: Level[] | undefined;
}

export type BookListener = (change: BookChange) => void;

/**
 * - `ok`: every event applied.
 * - `gap`: an event was out of sequence or did not match the book.
 * - `reset`: a RESET event: the exchange replaced the book.
 *
 * Anything but `ok` leaves the book `stale`: `reset` it from a snapshot.
 */
export type ApplyResult = "ok" | "gap" | "reset";

const copyOrder = (o: BookOrder): BookOrder => ({
  orderId: o.orderId,
  side: o.side,
  price: o.price,
  size: o.size,
  entryTime: o.entryTime,
  priority: o.priority,
});

const sameArray = <T>(a: readonly T[], b: readonly T[]) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

/** Index at which an order of `priority` goes, keeping `orders` sorted. */
const insertAt = (orders: readonly BookOrder[], priority: number) => {
  let lo = 0;
  let hi = orders.length;
  // fast path: an order joins the back of the queue
  if (hi === 0 || orders[hi - 1].priority < priority) return hi;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (orders[mid].priority < priority) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

/**
 * The order-by-order (L3) book of one instrument: every resting order, the
 * queue at each price and each order's place in it. Anonymous, and free of
 * any UI or transport: feed it `bookOrders` snapshots (`reset`) and
 * `bookEvents` (`apply`).
 *
 * Queue order follows the exchange: snapshot orders are ordered by
 * `priority`; an ADD joins the back of its level; EXECUTE and REDUCE keep
 * the order's place. A `Level` object is replaced only when its queue
 * changes.
 */
export class BookBuilder {
  readonly #orders = new Map<string, BookOrder>();
  readonly #sides: Record<Side, SideState> = {
    [Side.Buy]: { levels: new Map(), prices: undefined, sorted: undefined },
    [Side.Sell]: { levels: new Map(), prices: undefined, sorted: undefined },
  };
  readonly #listeners = new Set<BookListener>();
  /** Levels touched since the last commit. */
  readonly #dirty = new Set<LevelState>();
  /** Orders touched since the last commit. */
  readonly #changed = new Set<string>();
  #seq = 0;
  #status: BookStatus = "empty";
  /** Highest priority in the book; the next ADD goes after it. */
  #lastPriority = 0;
  /** Tracked orders (see `track`). */
  readonly #activity = new Map<string, QueueActivity>();

  /** Seq of the last event applied, or of the snapshot. */
  get seq() {
    return this.#seq;
  }

  get status(): BookStatus {
    return this.#status;
  }

  /** Resting orders. */
  get orderCount() {
    return this.#orders.size;
  }

  /**
   * Load a full snapshot of the book (all resting orders), as of event
   * `seq`. The book is diffed against it: unchanged orders and levels keep
   * their objects. Clears `stale`.
   */
  reset(orders: Iterable<BookOrder>, seq = 0) {
    if (this.#status === "empty") {
      // the first load: orders tracked before it start counting from here
      for (const a of this.#activity.values())
        this.#setActivity({ ...a, since: seq });
    } else if (this.#status !== "live" || seq !== this.#seq) {
      // events between the book's seq and the snapshot's were not seen
      this.#markPartial();
    }
    const next = new Map<string, BookOrder>();
    let lastPriority = 0;
    for (const o of orders) {
      next.set(o.orderId, o);
      if (o.priority > lastPriority) lastPriority = o.priority;
    }
    for (const [orderId, old] of this.#orders) {
      if (!next.has(orderId)) this.#remove(old);
    }
    for (const o of next.values()) {
      const old = this.#orders.get(o.orderId);
      if (old === undefined) {
        this.#insert(copyOrder(o));
      } else if (
        old.side !== o.side ||
        old.price !== o.price ||
        old.priority !== o.priority
      ) {
        this.#remove(old);
        this.#insert(copyOrder(o));
      } else if (old.size !== o.size || old.entryTime !== o.entryTime) {
        this.#replace(old, copyOrder(o));
      }
    }
    this.#lastPriority = lastPriority;
    this.#seq = seq;
    this.#status = "live";
    this.#commit();
  }

  /**
   * Apply events in seq order; events at or before `seq` are skipped. Stops
   * at the first event that is out of sequence or does not match the book
   * ("gap"), or at a RESET ("reset"), and marks the book `stale`: `reset`
   * it from a snapshot at or after that seq. Listeners hear once per call.
   * Returns "gap" without applying anything unless the book is `live`.
   */
  apply(events: readonly BookEvent[]): ApplyResult {
    if (this.#status !== "live") return "gap";
    let result: ApplyResult = "ok";
    for (const event of events) {
      if (event.seq <= this.#seq) continue;
      if (event.seq !== this.#seq + 1) {
        result = "gap";
      } else if (event.type === BookEventType.Reset) {
        this.#seq = event.seq;
        result = "reset";
      } else if (!this.#applyOne(event)) {
        result = "gap";
      }
      if (result !== "ok") {
        this.#status = "stale";
        break;
      }
      this.#seq = event.seq;
    }
    this.#commit();
    return result;
  }

  /** Levels of one side, best first (bids high to low, asks low to high). */
  levels(side: Side, depth?: number): readonly Level[] {
    const state = this.#sides[side];
    let sorted = state.sorted;
    if (sorted === undefined) {
      let prices = state.prices;
      if (prices === undefined) {
        prices = [...state.levels.keys()];
        prices.sort(side === Side.Buy ? (a, b) => b - a : (a, b) => a - b);
        state.prices = prices;
      }
      sorted = prices.map((p) => state.levels.get(p)?.level as Level);
      state.sorted = sorted;
    }
    return depth === undefined || depth >= sorted.length
      ? sorted
      : sorted.slice(0, depth);
  }

  level(side: Side, price: number): Level | undefined {
    return this.#sides[side].levels.get(price)?.level;
  }

  /** Where `orderId` rests, or undefined if it is not in the book. */
  order(orderId: string): OrderPosition | undefined {
    const order = this.#orders.get(orderId);
    if (order === undefined) return undefined;
    const level = this.level(order.side, order.price);
    if (level === undefined) return undefined;
    const place = queuePosition(level, orderId);
    return place && { order, level, ...place };
  }

  /**
   * Count what happens in the queue ahead of `orderId` (which need not be
   * in the book yet) from now on: see `activity`. Changes to it are reported
   * in `BookChange.orderIds`.
   */
  track(orderId: string) {
    if (this.#activity.has(orderId)) return;
    this.#activity.set(orderId, {
      orderId,
      since: this.#seq,
      filledAhead: 0,
      cancelledAhead: 0,
      filled: 0,
      partial: false,
    });
  }

  untrack(orderId: string) {
    this.#activity.delete(orderId);
  }

  /** Ids of the tracked orders. */
  tracked(): IterableIterator<string> {
    return this.#activity.keys();
  }

  /** What happened ahead of a tracked order, or undefined if not tracked. */
  activity(orderId: string): QueueActivity | undefined {
    return this.#activity.get(orderId);
  }

  /** Hear every change; returns an unsubscribe function. */
  subscribe(listener: BookListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  // ------------------------------------------------------------ internals

  #applyOne(e: BookEvent): boolean {
    if (e.type === BookEventType.Add) {
      const { side } = e;
      if (side === "" || this.#orders.has(e.orderId) || e.leaves !== e.size) {
        return false;
      }
      this.#insert({
        orderId: e.orderId,
        side,
        price: e.price,
        size: e.size,
        entryTime: e.timestamp,
        priority: ++this.#lastPriority,
      });
      return true;
    }
    if (
      e.type !== BookEventType.Execute &&
      e.type !== BookEventType.Reduce &&
      e.type !== BookEventType.Delete
    ) {
      return false;
    }
    const order = this.#orders.get(e.orderId);
    if (
      order === undefined ||
      order.side !== e.side ||
      order.price !== e.price ||
      order.size - e.size !== e.leaves ||
      e.leaves < 0
    ) {
      return false;
    }
    if (this.#activity.size > 0) this.#countActivity(order, e);
    if (e.leaves === 0) this.#remove(order);
    else this.#replace(order, { ...order, size: e.leaves });
    return true;
  }

  /** `e` (an EXECUTE, REDUCE or DELETE of `order`) as seen by tracked orders. */
  #countActivity(order: BookOrder, e: BookEvent) {
    const executed = e.type === BookEventType.Execute;
    for (const [id, a] of this.#activity) {
      if (id === order.orderId) {
        if (executed) this.#setActivity({ ...a, filled: a.filled + e.size });
        continue;
      }
      const tracked = this.#orders.get(id);
      if (
        tracked === undefined ||
        tracked.side !== order.side ||
        tracked.price !== order.price ||
        tracked.priority < order.priority
      ) {
        continue;
      }
      this.#setActivity(
        executed
          ? { ...a, filledAhead: a.filledAhead + e.size }
          : { ...a, cancelledAhead: a.cancelledAhead + e.size },
      );
    }
  }

  #setActivity(activity: QueueActivity) {
    this.#activity.set(activity.orderId, activity);
    this.#changed.add(activity.orderId);
  }

  #markPartial() {
    for (const a of this.#activity.values()) {
      if (!a.partial) this.#setActivity({ ...a, partial: true });
    }
  }

  #levelState(side: Side, price: number) {
    const state = this.#sides[side];
    let level = state.levels.get(price);
    if (level === undefined) {
      level = { side, price, orders: [], level: undefined };
      state.levels.set(price, level);
      state.prices = undefined;
    }
    return level;
  }

  #insert(order: BookOrder) {
    const level = this.#levelState(order.side, order.price);
    level.orders.splice(insertAt(level.orders, order.priority), 0, order);
    this.#orders.set(order.orderId, order);
    this.#touch(level, order.orderId);
  }

  #remove(order: BookOrder) {
    const level = this.#sides[order.side].levels.get(order.price);
    if (level) {
      const i = level.orders.indexOf(order);
      if (i >= 0) level.orders.splice(i, 1);
      this.#touch(level, order.orderId);
    }
    this.#orders.delete(order.orderId);
  }

  /** Same side, price and priority: the order keeps its place. */
  #replace(old: BookOrder, order: BookOrder) {
    const level = this.#sides[old.side].levels.get(old.price);
    if (level) {
      const i = level.orders.indexOf(old);
      if (i >= 0) level.orders[i] = order;
      this.#touch(level, order.orderId);
    }
    this.#orders.set(order.orderId, order);
  }

  #touch(level: LevelState, orderId: string) {
    this.#dirty.add(level);
    this.#changed.add(orderId);
  }

  #commit() {
    if (this.#dirty.size === 0 && this.#changed.size === 0) return;
    const levels: Level[] = [];
    const removed: LevelKey[] = [];
    for (const state of this.#dirty) {
      const { side, price, orders } = state;
      const sideState = this.#sides[side];
      if (orders.length === 0) {
        sideState.levels.delete(price);
        sideState.prices = undefined;
        sideState.sorted = undefined;
        if (state.level) removed.push({ side, price });
        continue;
      }
      if (state.level && sameArray(state.level.orders, orders)) continue;
      let total = 0;
      for (let i = 0; i < orders.length; i++) total += orders[i].size;
      state.level = {
        side,
        price,
        total,
        count: orders.length,
        orders: orders.slice(),
      };
      sideState.sorted = undefined;
      levels.push(state.level);
    }
    const orderIds = [...this.#changed];
    this.#dirty.clear();
    this.#changed.clear();
    if (levels.length === 0 && removed.length === 0 && orderIds.length === 0) {
      return;
    }
    const change: BookChange = { levels, removed, orderIds };
    for (const listener of this.#listeners) listener(change);
  }
}

/** 1-based place of `orderId` in `level` and the size ahead of it. */
export const queuePosition = (
  level: Level,
  orderId: string,
): { rank: number; ahead: number } | undefined => {
  let ahead = 0;
  const { orders } = level;
  for (let i = 0; i < orders.length; i++) {
    if (orders[i].orderId === orderId) return { rank: i + 1, ahead };
    ahead += orders[i].size;
  }
  return undefined;
};
