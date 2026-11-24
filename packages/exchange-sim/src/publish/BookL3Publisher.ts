import {
  BookEventType,
  bookEventKey,
  bookEvents as bookEventsDef,
  bookOrders as bookOrdersDef,
  bookStatus as bookStatusDef,
} from "@heswell/trading-schemas";
import {
  type BookEvent,
  type BookEventSink,
  fromBookSide,
  type InstrumentBook,
} from "../engine/InstrumentBook";
import { type PublishTable, type RowValue, RowLayout } from "./rows";
import { TradeRingBuffer } from "./TradeRingBuffer";

export interface BookL3Options {
  /** Keep the `bookOrders` table (one row per resting order) and `bookStatus`. */
  orders: boolean;
  /** Append every event to the `bookEvents` tape. */
  events: boolean;
  /** `bookEvents` rows kept (oldest deleted). */
  eventsCapacity: number;
}

export interface BookL3Stats {
  bookOrderUpdates: number;
  bookStatusUpdates: number;
  bookEventInserts: number;
  bookEventEvictions: number;
}

interface DirtyOrder {
  book: InstrumentBook;
  seq: number;
}

/** What the last `bookStatus` row of a book said. */
interface BookStatus {
  seq: number;
  orders: number;
  resetSeq: number;
}

/**
 * Publishes order-by-order (L3) data from the books' events:
 *
 * - `bookOrders`: the resting orders. Changes are coalesced: each flush
 *   writes the current state of every order touched since the last one.
 * - `bookEvents`: every event, in order, ring buffered. Rows are buffered
 *   and written on flush, like the trades tape.
 * - `bookStatus`: per book, the event seq its `bookOrders` rows were written
 *   at (the snapshot marker), its order count and its last RESET. Written
 *   after `bookOrders` in the same flush.
 */
export class BookL3Publisher implements BookEventSink {
  readonly #orders: PublishTable | undefined;
  readonly #events: PublishTable | undefined;
  readonly #status: PublishTable | undefined;
  readonly #orderLayout: RowLayout<typeof bookOrdersDef> | undefined;
  readonly #statusLayout: RowLayout<typeof bookStatusDef> | undefined;
  readonly #eventLayout: RowLayout<typeof bookEventsDef> | undefined;
  readonly #ring: TradeRingBuffer | undefined;
  /** Orders touched since the last flush. */
  readonly #dirty = new Map<string, DirtyOrder>();
  /** Order id -> ric of every published `bookOrders` row. */
  readonly #published = new Map<string, string>();
  /** Ric -> published `bookOrders` rows. */
  readonly #counts = new Map<string, number>();
  /** Attached books, and what their `bookStatus` row last said. */
  readonly #books = new Map<InstrumentBook, BookStatus | undefined>();
  /** Ric -> seq of its last RESET event. */
  readonly #resetSeq = new Map<string, number>();
  readonly #reset = new Set<InstrumentBook>();
  readonly #pendingEvents: RowValue[][] = [];
  /** Order id -> queue priority (see bookOrders.priority). */
  readonly #priority = new Map<string, number>();
  #nextPriority = 0;

  constructor(
    tables: {
      bookOrders?: PublishTable;
      bookEvents?: PublishTable;
      bookStatus?: PublishTable;
    },
    options: BookL3Options,
    readonly stats: BookL3Stats,
  ) {
    if (options.orders && tables.bookOrders) {
      this.#orders = tables.bookOrders;
      this.#orderLayout = new RowLayout(tables.bookOrders, bookOrdersDef);
      if (tables.bookStatus) {
        this.#status = tables.bookStatus;
        this.#statusLayout = new RowLayout(tables.bookStatus, bookStatusDef);
      }
    }
    if (options.events && tables.bookEvents) {
      this.#events = tables.bookEvents;
      this.#eventLayout = new RowLayout(tables.bookEvents, bookEventsDef);
      this.#ring = new TradeRingBuffer(options.eventsCapacity);
    }
  }

  /** True when there is anything to publish. */
  get enabled() {
    return this.#orders !== undefined || this.#events !== undefined;
  }

  get eventsBuffered() {
    return this.#ring?.size ?? 0;
  }

  /** Start listening to `books` and publish the orders already resting. */
  attach(books: readonly InstrumentBook[]) {
    for (const book of books) {
      book.bookEvents = this;
      this.#reset.add(book);
      this.#books.set(book, undefined);
    }
  }

  onBookEvent(book: InstrumentBook, event: Readonly<BookEvent>) {
    if (event.type === BookEventType.Reset) {
      // the book was replaced: re-list it; no order rows to mark
      this.#reset.add(book);
      this.#resetSeq.set(book.ric, event.seq);
    } else if (this.#orders) {
      if (event.type === BookEventType.Add) {
        this.#priority.set(event.orderId, ++this.#nextPriority);
      }
      const dirty = this.#dirty.get(event.orderId);
      if (dirty) dirty.seq = event.seq;
      else this.#dirty.set(event.orderId, { book, seq: event.seq });
    }
    const layout = this.#eventLayout;
    if (layout) {
      const { idx } = layout;
      const row = layout.row();
      row[idx.id] = bookEventKey(book.ric, event.seq);
      row[idx.ric] = book.ric;
      row[idx.seq] = event.seq;
      row[idx.type] = event.type;
      row[idx.orderId] = event.orderId;
      row[idx.side] = event.side;
      row[idx.price] = event.price;
      row[idx.size] = event.size;
      row[idx.leaves] = event.leaves;
      row[idx.tradeId] = event.tradeId;
      row[idx.timestamp] = event.timestamp;
      this.#pendingEvents.push(row);
    }
  }

  flush() {
    if (this.#orders) {
      this.#publishResets();
      this.#publishOrders();
      this.#publishStatus();
    }
    this.#publishEvents();
  }

  /** Replace every row of a reset book with its current resting orders. */
  #publishResets() {
    if (this.#reset.size === 0) return;
    const table = this.#orders as PublishTable;
    const rics = new Set<string>();
    for (const book of this.#reset) rics.add(book.ric);
    for (const [orderId, ric] of this.#published) {
      if (!rics.has(ric)) continue;
      table.delete(orderId);
      this.#unpublished(orderId, ric);
      this.#priority.delete(orderId);
      this.stats.bookOrderUpdates++;
    }
    for (const book of this.#reset) {
      // snapshot order is queue order within each level
      for (const order of book.restingOrders()) {
        this.#priority.set(order.id, ++this.#nextPriority);
        this.#dirty.set(order.id, { book, seq: book.eventSeq });
      }
    }
    this.#reset.clear();
  }

  #publishOrders() {
    if (this.#dirty.size === 0) return;
    const table = this.#orders as PublishTable;
    const layout = this.#orderLayout as RowLayout<typeof bookOrdersDef>;
    const { idx } = layout;
    for (const [orderId, { book, seq }] of this.#dirty) {
      const order = book.book.order(orderId);
      const published = this.#published.get(orderId);
      if (order === undefined) {
        this.#priority.delete(orderId);
        if (published !== undefined) {
          table.delete(orderId);
          this.#unpublished(orderId, published);
          this.stats.bookOrderUpdates++;
        }
        continue;
      }
      const row = layout.row();
      row[idx.orderId] = orderId;
      row[idx.ric] = book.ric;
      row[idx.side] = fromBookSide(order.side);
      row[idx.price] = order.price;
      row[idx.size] = order.size;
      row[idx.entryTime] = order.time;
      row[idx.seq] = seq;
      row[idx.priority] = this.#priority.get(orderId) ?? 0;
      if (published !== undefined) {
        table.update(table.rowIndexAtKey(orderId), row);
      } else {
        table.insert(row);
        this.#published.set(orderId, book.ric);
        this.#counts.set(book.ric, (this.#counts.get(book.ric) ?? 0) + 1);
      }
      this.stats.bookOrderUpdates++;
    }
    this.#dirty.clear();
  }

  #unpublished(orderId: string, ric: string) {
    this.#published.delete(orderId);
    this.#counts.set(ric, (this.#counts.get(ric) ?? 1) - 1);
  }

  /**
   * One `bookStatus` row per book whose seq, order count or last reset
   * changed. Runs after #publishOrders, so `seq` is the event seq the
   * book's `bookOrders` rows now reflect.
   */
  #publishStatus() {
    const table = this.#status;
    if (!table) return;
    const layout = this.#statusLayout as RowLayout<typeof bookStatusDef>;
    const { idx } = layout;
    for (const [book, last] of this.#books) {
      const seq = book.eventSeq;
      const orders = this.#counts.get(book.ric) ?? 0;
      const resetSeq = this.#resetSeq.get(book.ric) ?? 0;
      if (
        last?.seq === seq &&
        last.orders === orders &&
        last.resetSeq === resetSeq
      ) {
        continue;
      }
      const row = layout.row();
      row[idx.ric] = book.ric;
      row[idx.seq] = seq;
      row[idx.orders] = orders;
      row[idx.resetSeq] = resetSeq;
      if (last) table.update(table.rowIndexAtKey(book.ric), row);
      else table.insert(row);
      this.#books.set(book, { seq, orders, resetSeq });
      this.stats.bookStatusUpdates++;
    }
  }

  #publishEvents() {
    const pending = this.#pendingEvents;
    if (pending.length === 0) return;
    const table = this.#events as PublishTable;
    const ring = this.#ring as TradeRingBuffer;
    const keyIdx = (this.#eventLayout as RowLayout<typeof bookEventsDef>).idx
      .id;
    for (let i = 0; i < pending.length; i++) {
      const row = pending[i];
      const evicted = ring.push(row[keyIdx] as string);
      if (evicted !== undefined) {
        table.delete(evicted);
        this.stats.bookEventEvictions++;
      }
      table.insert(row);
      this.stats.bookEventInserts++;
    }
    pending.length = 0;
  }
}
