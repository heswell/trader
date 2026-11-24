import { BookBuilder } from "./BookBuilder";
import type { BookEvent, BookOrder } from "./types";

/** A `bookOrders` row: a resting order plus the seq of its last change. */
export interface SnapshotOrder extends BookOrder {
  /** Seq of the order's last event. */
  readonly seq: number;
}

/** The instrument's `bookStatus` row: the snapshot marker. */
export interface SnapshotMarker {
  /** Last event seq the `bookOrders` rows reflect. */
  readonly seq: number;
  /** `bookOrders` rows for the instrument. */
  readonly orders: number;
}

export interface BookFeedStats {
  /** Events applied. */
  events: number;
  /** Snapshots loaded after the first: on a gap, a RESET, falling behind or a mismatch. */
  resyncs: number;
  /** Events missed (the tape moved past the book's seq). */
  gaps: number;
  /** RESET events (the exchange replaced the book). */
  resets: number;
  /** Snapshots at the book's seq that did not match it. */
  mismatches: number;
}

/**
 * - `waiting`: no consistent snapshot yet, or resyncing.
 * - `events`: kept up to date by `bookEvents`, checked against snapshots.
 * - `snapshot`: no events seen (the tape is off): each snapshot is loaded.
 */
export type BookFeedSource = "waiting" | "events" | "snapshot";

export interface BookFeedOptions {
  /** Events held while waiting for a snapshot (oldest dropped). Default 20,000. */
  maxBuffered?: number;
}

/**
 * Keeps a `BookBuilder` in step with an exchange's L3 feed, as delivered by
 * table viewports: the `bookOrders` snapshot, its `bookStatus` marker and
 * windows of the `bookEvents` tape (any order, any overlap). Free of any UI
 * or transport.
 *
 * - Events are buffered by seq and applied in order once a snapshot is
 *   loaded; those at or before the book's seq are dropped.
 * - A snapshot is used only when it is consistent with its marker: as many
 *   rows as `orders` and none newer than `seq`. The two come from separate
 *   viewports, so a marker can arrive ahead of its rows.
 * - On a gap or a RESET the book is stale until the next consistent
 *   snapshot, then the buffer is replayed after its marker.
 * - While live, a snapshot at the book's seq is compared with the book, and
 *   loaded if two in a row differ from it; a snapshot ahead of the book with no events to
 *   catch up with is loaded on the next one (at once if no event was ever
 *   seen, i.e. the tape is off).
 */
export class BookFeed {
  readonly book = new BookBuilder();
  readonly stats: BookFeedStats = {
    events: 0,
    resyncs: 0,
    gaps: 0,
    resets: 0,
    mismatches: 0,
  };
  readonly #buffer = new Map<number, BookEvent>();
  readonly #maxBuffered: number;
  #eventsSeen = false;
  #loaded = false;
  /** Book seq when a snapshot last found the book behind it. */
  #behindAt: number | undefined;
  /** A snapshot at the book's seq did not match it (not yet acted on). */
  #mismatched = false;

  constructor({ maxBuffered = 20_000 }: BookFeedOptions = {}) {
    this.#maxBuffered = maxBuffered;
  }

  get source(): BookFeedSource {
    if (this.book.status !== "live") return "waiting";
    return this.#eventsSeen ? "events" : "snapshot";
  }

  /** Events not yet applied. */
  get buffered() {
    return this.#buffer.size;
  }

  /** A window of the tape: any events, in any order, already seen or not. */
  events(window: Iterable<BookEvent>) {
    const live = this.book.status === "live";
    const seq = this.book.seq;
    for (const e of window) {
      this.#eventsSeen = true;
      if (live && e.seq <= seq) continue;
      if (!this.#buffer.has(e.seq)) this.#buffer.set(e.seq, e);
    }
    this.#trim();
    this.#drain();
  }

  /** The `bookOrders` rows of the instrument and its `bookStatus` row. */
  snapshot(rows: readonly SnapshotOrder[], marker: SnapshotMarker | undefined) {
    if (marker === undefined || !consistent(rows, marker)) return;
    const book = this.book;
    if (book.status !== "live") {
      this.#load(rows, marker);
      return;
    }
    if (marker.seq === book.seq) {
      this.#behindAt = undefined;
      if (sameBook(book, rows)) {
        this.#mismatched = false;
      } else if (this.#mismatched) {
        // twice in a row: the book is wrong, not the pairing of the rows
        // with their marker (a marker can arrive ahead of its rows)
        this.stats.mismatches++;
        this.#load(rows, marker);
      } else {
        this.#mismatched = true;
      }
    } else if (marker.seq > book.seq) {
      // ahead of the book: give the events one snapshot to catch up
      if (!this.#eventsSeen || this.#behindAt === book.seq) {
        this.#load(rows, marker);
      } else {
        this.#behindAt = book.seq;
      }
    }
    // a marker behind the book is an old snapshot: nothing to learn
  }

  #load(rows: readonly SnapshotOrder[], marker: SnapshotMarker) {
    if (this.#loaded) this.stats.resyncs++;
    this.#loaded = true;
    this.#behindAt = undefined;
    this.#mismatched = false;
    this.book.reset(rows, marker.seq);
    this.#drain();
  }

  #drain() {
    const book = this.book;
    if (book.status !== "live" || this.#buffer.size === 0) return;
    const seq = book.seq;
    const pending: BookEvent[] = [];
    for (const [s, e] of this.#buffer) {
      if (s <= seq) this.#buffer.delete(s);
      else pending.push(e);
    }
    if (pending.length === 0) return;
    pending.sort((a, b) => a.seq - b.seq);
    const result = book.apply(pending);
    this.stats.events += book.seq - seq;
    for (const s of this.#buffer.keys()) {
      if (s <= book.seq) this.#buffer.delete(s);
    }
    if (result === "gap") this.stats.gaps++;
    else if (result === "reset") this.stats.resets++;
  }

  #trim() {
    const excess = this.#buffer.size - this.#maxBuffered;
    if (excess <= 0) return;
    const seqs = [...this.#buffer.keys()].sort((a, b) => a - b);
    for (let i = 0; i < excess; i++) this.#buffer.delete(seqs[i]);
  }
}

const consistent = (rows: readonly SnapshotOrder[], marker: SnapshotMarker) => {
  if (rows.length !== marker.orders) return false;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].seq > marker.seq) return false;
  }
  return true;
};

/** The book holds exactly `rows`: same orders, sizes and queue order. */
const sameBook = (book: BookBuilder, rows: readonly SnapshotOrder[]) => {
  if (rows.length !== book.orderCount) return false;
  const byLevel = new Map<string, SnapshotOrder[]>();
  for (const row of rows) {
    const held = book.order(row.orderId)?.order;
    if (
      held === undefined ||
      held.size !== row.size ||
      held.price !== row.price ||
      held.side !== row.side
    ) {
      return false;
    }
    const key = `${row.side}|${row.price}`;
    const level = byLevel.get(key);
    if (level) level.push(row);
    else byLevel.set(key, [row]);
  }
  for (const level of byLevel.values()) {
    const [first] = level;
    const held = book.level(first.side, first.price)?.orders;
    if (held === undefined || held.length !== level.length) return false;
    level.sort((a, b) => a.priority - b.priority);
    for (let i = 0; i < level.length; i++) {
      if (held[i].orderId !== level[i].orderId) return false;
    }
  }
  return true;
};
