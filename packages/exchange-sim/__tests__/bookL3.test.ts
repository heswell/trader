import { describe, expect, test } from "bun:test";
import { BookBuilder, BookFeed, type SnapshotOrder } from "@heswell/book-model";
import { Side as BookSide } from "@heswell/hft-limit-order-book";
import {
  BookEventType,
  bookEventKey,
  type BookEventType as EventType,
  Side,
} from "@heswell/trading-schemas";
import { createExchangeSimulator } from "../src/engine/ExchangeSimulator";
import type {
  BookEvent,
  BookEventSink,
  FillSink,
  InstrumentBook,
} from "../src/engine/InstrumentBook";
import { ManualClock } from "../src/util/clock";
import { createFakeTables } from "./fakeTables";

const { Add, Execute, Reduce, Delete, Reset } = BookEventType;

/** Replace the book with its own resting orders, as a restore does. */
const restoreInPlace = (book: InstrumentBook) =>
  book.restore(book.restingOrders(), { onFill() {} } as FillSink);

/** `bookOrders` rows of one instrument as book-model orders. */
const snapshotOf = (tables: ReturnType<typeof createFakeTables>, ric: string) =>
  tables.bookOrders
    .all()
    .filter((r) => r.ric === ric)
    .map((r) => ({
      orderId: r.orderId as string,
      side: r.side as Side,
      price: r.price as number,
      size: r.size as number,
      entryTime: r.entryTime as number,
      priority: r.priority as number,
    }));

/** Records every event, then passes it on to the book's existing sink. */
const record = (book: InstrumentBook) => {
  const events: BookEvent[] = [];
  const next = book.bookEvents;
  const sink: BookEventSink = {
    onBookEvent(b, event) {
      events.push({ ...event });
      next?.onBookEvent(b, event);
    },
  };
  book.bookEvents = sink;
  return events;
};

/** One instrument, bots paused: the test drives the book directly. */
const quietSim = (config = {}) => {
  const clock = new ManualClock();
  const sim = createExchangeSimulator({
    clock: clock.now,
    config: { instruments: "AAPL.OQ", mmRate: 0, takerRate: 0, ...config },
  });
  const tables = createFakeTables();
  sim.attachTables(tables);
  const book = sim.getBook("AAPL.OQ");
  if (!book) throw Error("no book");
  const events = record(book);
  let n = 0;
  const limit = (side: BookSide, price: number, size: number) => {
    const id = `t${++n}`;
    book.limit({ id, side, price, size });
    return id;
  };
  return { clock, sim, tables, book, events, limit };
};

const shape = (events: BookEvent[]) =>
  events.map(({ type, orderId, side, price, size, leaves }) => [
    type,
    orderId,
    side,
    price,
    size,
    leaves,
  ]);

describe("InstrumentBook L3 events", () => {
  test("a resting limit is an ADD", () => {
    const { events, limit } = quietSim();
    const id = limit(BookSide.BUY, 100, 50);
    expect(shape(events)).toEqual([[Add, id, Side.Buy, 100, 50, 50]]);
    expect(events[0].seq).toBe(1);
    expect(events[0].tradeId).toBe("");
  });

  test("an aggressive limit EXECUTEs the makers, then ADDs its remainder", () => {
    const { events, limit, book } = quietSim();
    const a = limit(BookSide.SELL, 100, 30);
    const b = limit(BookSide.SELL, 100.01, 40);
    events.length = 0;
    const c = limit(BookSide.BUY, 100.02, 100);
    expect(shape(events)).toEqual([
      [Execute, a, Side.Sell, 100, 30, 0],
      [Execute, b, Side.Sell, 100.01, 40, 0],
      [Add, c, Side.Buy, 100.02, 30, 30],
    ]);
    expect(events.map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(events[0].tradeId).toMatch(/^TR/);
    expect(book.eventSeq).toBe(5);
  });

  test("a partial fill reports what is left on the maker", () => {
    const { events, limit, book } = quietSim();
    const a = limit(BookSide.SELL, 100, 100);
    events.length = 0;
    book.market({ id: "m1", side: BookSide.BUY, size: 25 });
    expect(shape(events)).toEqual([[Execute, a, Side.Sell, 100, 25, 75]]);
  });

  test("an amend down at the same price is a REDUCE and keeps priority", () => {
    const { events, limit, book } = quietSim();
    const a = limit(BookSide.BUY, 100, 50);
    events.length = 0;
    book.modify(a, { size: 20 });
    expect(shape(events)).toEqual([[Reduce, a, Side.Buy, 100, 30, 20]]);
  });

  test("an amend that loses priority is a DELETE then an ADD", () => {
    const { events, limit, book } = quietSim();
    const a = limit(BookSide.BUY, 100, 50);
    events.length = 0;
    book.modify(a, { price: 99.99 });
    book.modify(a, { size: 80 });
    expect(shape(events)).toEqual([
      [Delete, a, Side.Buy, 100, 50, 0],
      [Add, a, Side.Buy, 99.99, 50, 50],
      [Delete, a, Side.Buy, 99.99, 50, 0],
      [Add, a, Side.Buy, 99.99, 80, 80],
    ]);
  });

  test("an amend that crosses sends its DELETE before the executions", () => {
    const { events, limit, book } = quietSim();
    const ask = limit(BookSide.SELL, 100.05, 20);
    const bid = limit(BookSide.BUY, 100, 50);
    events.length = 0;
    book.modify(bid, { price: 100.05 });
    expect(shape(events)).toEqual([
      [Delete, bid, Side.Buy, 100, 50, 0],
      [Execute, ask, Side.Sell, 100.05, 20, 0],
      [Add, bid, Side.Buy, 100.05, 30, 30],
    ]);
  });

  test("a rejected amend sends nothing; a cancel is a DELETE", () => {
    const { events, limit, book } = quietSim();
    const a = limit(BookSide.BUY, 100, 50);
    events.length = 0;
    book.modify("nope", { price: 1 });
    book.modify(a, { price: -1 });
    expect(events).toEqual([]);
    book.cancel(a);
    book.cancel(a);
    expect(shape(events)).toEqual([[Delete, a, Side.Buy, 100, 50, 0]]);
  });

  test("a restore is a RESET with the next seq", () => {
    const { events, limit, book } = quietSim();
    limit(BookSide.BUY, 100, 50);
    events.length = 0;
    restoreInPlace(book);
    expect(shape(events)).toEqual([[Reset, "", "", 0, 0, 0]]);
    expect(events[0].seq).toBe(2);
    expect(book.eventSeq).toBe(2);
  });

  test("no events (and no extra work) without a sink", () => {
    const clock = new ManualClock();
    const sim = createExchangeSimulator({
      clock: clock.now,
      config: { instruments: "AAPL.OQ", mmRate: 0, takerRate: 0 },
    });
    const book = sim.getBook("AAPL.OQ") as InstrumentBook;
    expect(book.bookEvents).toBeUndefined();
    book.limit({ id: "x", side: BookSide.BUY, price: 100, size: 1 });
    expect(book.eventSeq).toBe(0);
  });
});

describe("bookOrders / bookEvents tables", () => {
  test("bookOrders holds the resting orders, coalesced per flush", () => {
    const { sim, tables, book, limit } = quietSim();
    const a = limit(BookSide.BUY, 100, 50);
    const b = limit(BookSide.SELL, 100.05, 20);
    expect(tables.bookOrders.rowCount).toBe(0);
    sim.flush();
    expect(tables.bookOrders.get(a)).toMatchObject({
      orderId: a,
      ric: "AAPL.OQ",
      side: Side.Buy,
      price: 100,
      size: 50,
      seq: 1,
    });
    tables.bookOrders.resetCounts();
    book.modify(a, { size: 40 });
    book.modify(a, { size: 30 });
    book.cancel(b);
    sim.flush();
    expect(tables.bookOrders.updates).toBe(1);
    expect(tables.bookOrders.deletes).toBe(1);
    expect(tables.bookOrders.get(a)?.size).toBe(30);
    expect(tables.bookOrders.get(b)).toBeUndefined();
    // the bookEvents tape is off by default
    expect(tables.bookEvents.rowCount).toBe(0);
  });

  test("priority is queue order: kept by a REDUCE, reset by a lost-priority amend", () => {
    const { sim, tables, book, limit } = quietSim();
    const a = limit(BookSide.BUY, 100, 50);
    const b = limit(BookSide.BUY, 100, 20);
    const c = limit(BookSide.BUY, 100, 10);
    sim.flush();
    const priority = (id: string) =>
      tables.bookOrders.get(id)?.priority as number;
    const queue = () => [a, b, c].sort((x, y) => priority(x) - priority(y));
    expect(queue()).toEqual([a, b, c]);
    book.modify(a, { size: 40 }); // REDUCE keeps its place
    sim.flush();
    expect(queue()).toEqual([a, b, c]);
    book.modify(a, { size: 60 }); // size up loses priority
    sim.flush();
    expect(queue()).toEqual([b, c, a]);
    // a restore re-lists the book in queue order
    restoreInPlace(book);
    sim.flush();
    expect(queue()).toEqual([b, c, a]);
  });

  test("bookStatus marks the event seq each bookOrders flush reflects", () => {
    const { sim, tables, book, limit } = quietSim();
    limit(BookSide.BUY, 100, 50);
    const b = limit(BookSide.SELL, 100.05, 20);
    sim.flush();
    expect(tables.bookStatus.get("AAPL.OQ")).toEqual({
      ric: "AAPL.OQ",
      seq: 2,
      orders: 2,
      resetSeq: 0,
    });
    tables.bookStatus.resetCounts();
    sim.flush();
    expect(tables.bookStatus.ops).toBe(0); // unchanged: not rewritten
    book.cancel(b);
    sim.flush();
    expect(tables.bookStatus.get("AAPL.OQ")).toMatchObject({
      seq: 3,
      orders: 1,
    });
    expect(tables.bookStatus.updates).toBe(1);
  });

  test("a restore puts RESET on the tape and re-lists bookOrders at its seq", () => {
    const { sim, tables, book, limit } = quietSim({ bookEvents: 1 });
    const a = limit(BookSide.BUY, 100, 50);
    sim.flush();
    restoreInPlace(book);
    sim.flush();
    expect(tables.bookEvents.get(bookEventKey("AAPL.OQ", 2))).toMatchObject({
      type: Reset,
      orderId: "",
      side: "",
      size: 0,
      leaves: 0,
    });
    expect(tables.bookOrders.get(a)?.seq).toBe(2);
    expect(tables.bookStatus.get("AAPL.OQ")).toMatchObject({
      seq: 2,
      orders: 1,
      resetSeq: 2,
    });
  });

  test("an order added and removed between flushes never appears", () => {
    const { sim, tables, book, limit } = quietSim();
    book.cancel(limit(BookSide.BUY, 100, 50));
    sim.flush();
    expect(tables.bookOrders.ops).toBe(0);
  });

  test("orders resting before the tables attach are published", () => {
    const clock = new ManualClock();
    const sim = createExchangeSimulator({
      clock: clock.now,
      config: { instruments: "AAPL.OQ", mmRate: 0, takerRate: 0 },
    });
    const book = sim.getBook("AAPL.OQ") as InstrumentBook;
    book.limit({ id: "early", side: BookSide.BUY, price: 100, size: 5 });
    const tables = createFakeTables();
    sim.attachTables(tables);
    expect(tables.bookOrders.get("early")?.size).toBe(5);
  });

  test("bookOrders = 0 disables the table and the events", () => {
    const clock = new ManualClock();
    const sim = createExchangeSimulator({
      clock: clock.now,
      config: {
        instruments: "AAPL.OQ",
        mmRate: 0,
        takerRate: 0,
        bookOrders: 0,
      },
    });
    const tables = createFakeTables();
    sim.attachTables(tables);
    const book = sim.getBook("AAPL.OQ") as InstrumentBook;
    book.limit({ id: "x", side: BookSide.BUY, price: 100, size: 50 });
    sim.flush();
    expect(tables.bookOrders.rowCount).toBe(0);
    expect(sim.publisher?.l3).toBeUndefined();
    expect(book.bookEvents).toBeUndefined();
    expect(book.eventSeq).toBe(0);
  });

  test("bookEvents tape: every event in order, ring buffered", () => {
    const { tables, sim, limit, book } = quietSim({
      bookEvents: 1,
      bookEventsCapacity: 3,
    });
    const a = limit(BookSide.SELL, 100, 30);
    limit(BookSide.BUY, 100, 10);
    book.cancel(a);
    expect(tables.bookEvents.rowCount).toBe(0);
    sim.flush();
    const rows = tables.bookEvents.all();
    expect(rows.map((r) => [r.seq, r.type, r.leaves])).toEqual([
      [1, Add, 30],
      [2, Execute, 20],
      [3, Delete, 0],
    ]);
    expect(rows[1].tradeId).toMatch(/^TR/);
    expect(rows[0].id).toBe(bookEventKey("AAPL.OQ", 1));
    limit(BookSide.BUY, 99, 1);
    sim.flush();
    expect(tables.bookEvents.get(bookEventKey("AAPL.OQ", 1))).toBeUndefined();
    expect(tables.bookEvents.rowCount).toBe(3);
    expect(sim.publisher?.stats.bookEventEvictions).toBe(1);
  });
});

describe("replaying bookEvents rebuilds the book", () => {
  /** Levels and queue order, best first, as the engine reports them. */
  const fromModel = (model: BookBuilder, side: Side) =>
    model.levels(side).map((l) => ({
      price: l.price,
      size: l.total,
      count: l.count,
      ids: l.orders.map((o) => o.orderId),
    }));

  const fromEngine = (book: InstrumentBook, side: Side) => {
    const { bids, asks } = book.book.snapshot();
    return (side === Side.Buy ? bids : asks).map((level) => ({
      price: level.price,
      size: level.orders.reduce((sum, o) => sum + o.size, 0),
      count: level.orders.length,
      ids: level.orders.map((o) => o.id),
    }));
  };

  test("bookOrders + the bookStatus marker + the tape after it = the engine, across a restore", () => {
    const clock = new ManualClock();
    const sim = createExchangeSimulator({
      clock: clock.now,
      config: {
        activeInstruments: 3,
        mmRate: 40,
        takerRate: 30,
        bookEvents: 1,
        bookEventsCapacity: 1_000_000,
      },
    });
    const tables = createFakeTables();
    sim.attachTables(tables);
    const run = (steps: number) => {
      for (let step = 0; step < steps; step++) {
        sim.step(clock.advance(20));
        if (step % 5 === 4) sim.flush();
      }
      sim.flush();
    };
    const status = (ric: string) => {
      const row = tables.bookStatus.get(ric);
      if (!row) throw Error(`no bookStatus for ${ric}`);
      return row as { seq: number; orders: number; resetSeq: number };
    };
    // load each book from a mid-session snapshot and its marker
    run(100);
    const models = new Map<InstrumentBook, BookBuilder>();
    for (const book of sim.books) {
      const snapshot = snapshotOf(tables, book.ric);
      expect(snapshot).toHaveLength(status(book.ric).orders);
      const model = new BookBuilder();
      model.reset(snapshot, status(book.ric).seq);
      models.set(book, model);
    }
    // more trading, with one book restored part way through
    run(100);
    const [restored] = sim.books;
    restoreInPlace(restored);
    const resetSeq = restored.eventSeq;
    run(100);
    expect(status(restored.ric).resetSeq).toBe(resetSeq);
    // replay the tape after each marker
    for (const book of sim.books) {
      const model = models.get(book) as BookBuilder;
      const tape = tables.bookEvents
        .all()
        .filter((r) => r.ric === book.ric)
        .sort((a, b) => (a.seq as number) - (b.seq as number))
        .map((r) => r as unknown as BookEvent);
      const result = model.apply(tape);
      if (book === restored) {
        expect(result).toBe("reset");
        expect(model.seq).toBe(resetSeq);
        // resync: the latest snapshot, then whatever came after it
        model.reset(snapshotOf(tables, book.ric), status(book.ric).seq);
        expect(model.apply(tape)).toBe("ok");
      } else {
        expect(result).toBe("ok");
      }
      expect(model.seq).toBe(book.eventSeq);
      expect(fromModel(model, Side.Buy)).toEqual(fromEngine(book, Side.Buy));
      expect(fromModel(model, Side.Sell)).toEqual(fromEngine(book, Side.Sell));
    }
  });

  test("BookFeed stays in step through skewed viewports, small windows and a restore", () => {
    const clock = new ManualClock();
    const sim = createExchangeSimulator({
      clock: clock.now,
      config: {
        activeInstruments: 3,
        mmRate: 40,
        takerRate: 30,
        bookEvents: 1,
        bookEventsCapacity: 1_000_000,
      },
    });
    const tables = createFakeTables();
    sim.attachTables(tables);
    let seed = 42;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    type View = {
      rows: SnapshotOrder[];
      marker: { seq: number; orders: number } | undefined;
    };
    const view = (ric: string): View => ({
      rows: snapshotOf(tables, ric).map((o) => ({
        ...o,
        seq: tables.bookOrders.get(o.orderId)?.seq as number,
      })),
      marker: tables.bookStatus.get(ric) as View["marker"],
    });
    /** The newest `size` tape rows of `ric`, newest first, as a viewport shows them. */
    const window = (ric: string, size: number) =>
      tables.bookEvents
        .all()
        .filter((r) => r.ric === ric)
        .sort((a, b) => (b.seq as number) - (a.seq as number))
        .slice(0, size)
        .map((r) => r as unknown as BookEvent);
    const feeds = new Map<InstrumentBook, BookFeed>();
    const previous = new Map<InstrumentBook, View>();
    for (const book of sim.books) feeds.set(book, new BookFeed());
    const deliver = (clean: boolean) => {
      for (const book of sim.books) {
        const feed = feeds.get(book) as BookFeed;
        const now = view(book.ric);
        const before = previous.get(book) ?? now;
        previous.set(book, now);
        if (clean || random() > 0.15) feed.events(window(book.ric, 40));
        const r = clean ? 1 : random();
        // rows and marker come from separate viewports: either can lag
        if (r < 0.2) feed.snapshot(before.rows, now.marker);
        else if (r < 0.4) feed.snapshot(now.rows, before.marker);
        else feed.snapshot(now.rows, now.marker);
      }
    };
    for (let step = 0; step < 600; step++) {
      sim.step(clock.advance(20));
      if (step === 300) restoreInPlace(sim.books[0]);
      if (step % 3 === 2) {
        sim.flush();
        deliver(false);
      }
    }
    for (let i = 0; i < 3; i++) {
      sim.flush();
      deliver(true);
    }
    let applied = 0;
    let total = 0;
    for (const book of sim.books) {
      const feed = feeds.get(book) as BookFeed;
      expect(feed.source).toBe("events");
      expect(feed.book.seq).toBe(book.eventSeq);
      expect(fromModel(feed.book, Side.Buy)).toEqual(
        fromEngine(book, Side.Buy),
      );
      expect(fromModel(feed.book, Side.Sell)).toEqual(
        fromEngine(book, Side.Sell),
      );
      applied += feed.stats.events;
      total += book.eventSeq;
    }
    // the books were kept up to date by events, not by reloading snapshots
    // (a resync, after a gap or the restore, skips the events it covers)
    expect(applied / total).toBeGreaterThan(0.8);
  });

  test("BookBuilder matches the engine after every step, with live bots", () => {
    const clock = new ManualClock();
    const sim = createExchangeSimulator({
      clock: clock.now,
      config: { activeInstruments: 5, mmRate: 40, takerRate: 30 },
    });
    const tables = createFakeTables();
    sim.attachTables(tables);
    const models = new Map<InstrumentBook, BookBuilder>();
    const types = new Map<EventType, number>();
    for (const book of sim.books) {
      const model = new BookBuilder();
      model.reset([], book.eventSeq);
      models.set(book, model);
      const next = book.bookEvents;
      book.bookEvents = {
        onBookEvent(b, e) {
          types.set(e.type, (types.get(e.type) ?? 0) + 1);
          const where = `${e.type} ${e.orderId} seq ${e.seq}`;
          const result = models.get(b)?.apply([e]);
          expect({ where, result }).toEqual({ where, result: "ok" });
          next?.onBookEvent(b, e);
        },
      };
    }
    for (let step = 0; step < 500; step++) {
      sim.step(clock.advance(20));
      if (step % 5 === 4) sim.flush();
      for (const book of sim.books) {
        const model = models.get(book) as BookBuilder;
        // L2 from the model = the engine's depth
        const [asks, bids] = book.book.depthDetailed();
        const l2 = (side: Side) =>
          model.levels(side).map((l) => ({
            price: l.price,
            size: l.total,
            count: l.count,
          }));
        expect(l2(Side.Buy)).toEqual(bids);
        expect(l2(Side.Sell)).toEqual(asks);
        // L3: the model's priority rule gives the engine's queue order
        expect(fromModel(model, Side.Buy)).toEqual(fromEngine(book, Side.Buy));
        expect(fromModel(model, Side.Sell)).toEqual(
          fromEngine(book, Side.Sell),
        );
        expect(model.seq).toBe(book.eventSeq);
      }
    }
    // the flow exercised every event type except REDUCE (bots never amend down)
    for (const type of [Add, Execute, Delete]) {
      expect(types.get(type) ?? 0).toBeGreaterThan(100);
    }
    // the coalesced bookOrders table agrees with the book
    sim.flush();
    const resting = sim.books.flatMap((b) => b.restingOrders());
    expect(tables.bookOrders.rowCount).toBe(resting.length);
    for (const o of resting) {
      expect(tables.bookOrders.get(o.id)?.size).toBe(o.size);
    }
    // and a model loaded from the bookOrders snapshot equals the one built
    // from events: same levels, sizes and queue order
    const rows = tables.bookOrders.all();
    for (const book of sim.books) {
      const snapshot = new BookBuilder();
      snapshot.reset(
        rows
          .filter((r) => r.ric === book.ric)
          .map((r) => ({
            orderId: r.orderId as string,
            side: r.side as Side,
            price: r.price as number,
            size: r.size as number,
            entryTime: r.entryTime as number,
            priority: r.priority as number,
          })),
        book.eventSeq,
      );
      const model = models.get(book) as BookBuilder;
      expect(fromModel(snapshot, Side.Buy)).toEqual(fromModel(model, Side.Buy));
      expect(fromModel(snapshot, Side.Sell)).toEqual(
        fromModel(model, Side.Sell),
      );
    }
  });
});
