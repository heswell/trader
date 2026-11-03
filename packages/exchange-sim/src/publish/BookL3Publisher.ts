import {
  bookEventKey,
  bookEvents as bookEventsDef,
  bookOrders as bookOrdersDef,
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
  /** Keep the `bookOrders` table (one row per resting order). */
  orders: boolean;
  /** Append every event to the `bookEvents` tape. */
  events: boolean;
  /** `bookEvents` rows kept (oldest deleted). */
  eventsCapacity: number;
}

export interface BookL3Stats {
  bookOrderUpdates: number;
  bookEventInserts: number;
  bookEventEvictions: number;
}

interface DirtyOrder {
  book: InstrumentBook;
  seq: number;
}

/**
 * Publishes order-by-order (L3) data from the books' events:
 *
 * - `bookOrders`: the resting orders. Changes are coalesced: each flush
 *   writes the current state of every order touched since the last one.
 * - `bookEvents`: every event, in order, ring buffered. Rows are buffered
 *   and written on flush, like the trades tape.
 */
export class BookL3Publisher implements BookEventSink {
  readonly #orders: PublishTable | undefined;
  readonly #events: PublishTable | undefined;
  readonly #orderLayout: RowLayout<typeof bookOrdersDef> | undefined;
  readonly #eventLayout: RowLayout<typeof bookEventsDef> | undefined;
  readonly #ring: TradeRingBuffer | undefined;
  /** Orders touched since the last flush. */
  readonly #dirty = new Map<string, DirtyOrder>();
  /** Order id -> ric of every published `bookOrders` row. */
  readonly #published = new Map<string, string>();
  readonly #reset = new Set<InstrumentBook>();
  readonly #pendingEvents: RowValue[][] = [];

  constructor(
    tables: { bookOrders?: PublishTable; bookEvents?: PublishTable },
    options: BookL3Options,
    readonly stats: BookL3Stats,
  ) {
    if (options.orders && tables.bookOrders) {
      this.#orders = tables.bookOrders;
      this.#orderLayout = new RowLayout(tables.bookOrders, bookOrdersDef);
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
    }
  }

  onBookEvent(book: InstrumentBook, event: Readonly<BookEvent>) {
    if (this.#orders) {
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

  onBookReset(book: InstrumentBook) {
    this.#reset.add(book);
  }

  flush() {
    if (this.#orders) {
      this.#publishResets();
      this.#publishOrders();
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
      this.#published.delete(orderId);
      this.stats.bookOrderUpdates++;
    }
    for (const book of this.#reset) {
      for (const order of book.restingOrders()) {
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
      const published = this.#published.has(orderId);
      if (order === undefined) {
        if (published) {
          table.delete(orderId);
          this.#published.delete(orderId);
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
      if (published) {
        table.update(table.rowIndexAtKey(orderId), row);
      } else {
        table.insert(row);
        this.#published.set(orderId, book.ric);
      }
      this.stats.bookOrderUpdates++;
    }
    this.#dirty.clear();
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
