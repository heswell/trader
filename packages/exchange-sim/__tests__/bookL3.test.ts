import { describe, expect, test } from "bun:test";
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
  InstrumentBook,
} from "../src/engine/InstrumentBook";
import { ManualClock } from "../src/util/clock";
import { createFakeTables } from "./fakeTables";

const { Add, Execute, Reduce, Delete } = BookEventType;

/** Records every event, then passes it on to the book's existing sink. */
const record = (book: InstrumentBook) => {
  const events: BookEvent[] = [];
  const next = book.bookEvents;
  const sink: BookEventSink = {
    onBookEvent(b, event) {
      events.push({ ...event });
      next?.onBookEvent(b, event);
    },
    onBookReset(b) {
      next?.onBookReset(b);
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
  type Rebuilt = Map<string, { side: Side; price: number; size: number }>;

  const apply = (book: Rebuilt, e: BookEvent) => {
    const order = book.get(e.orderId);
    const where = `${e.type} ${e.orderId} seq ${e.seq}`;
    if (e.type === Add) {
      expect({ where, exists: order !== undefined }).toEqual({
        where,
        exists: false,
      });
      expect(e.leaves).toBe(e.size);
      book.set(e.orderId, { side: e.side, price: e.price, size: e.size });
      return;
    }
    if (!order) throw Error(`${where}: unknown order`);
    expect({ where, side: e.side, price: e.price }).toEqual({
      where,
      side: order.side,
      price: order.price,
    });
    expect({ where, leaves: e.leaves }).toEqual({
      where,
      leaves: order.size - e.size,
    });
    if (e.type === Delete) expect(e.leaves).toBe(0);
    if (e.type === Reduce) expect(e.leaves).toBeGreaterThan(0);
    if (e.leaves === 0) book.delete(e.orderId);
    else order.size = e.leaves;
  };

  const levels = (book: Rebuilt, side: Side) => {
    const bySize = new Map<number, { size: number; count: number }>();
    for (const o of book.values()) {
      if (o.side !== side) continue;
      const level = bySize.get(o.price) ?? { size: 0, count: 0 };
      level.size += o.size;
      level.count++;
      bySize.set(o.price, level);
    }
    return [...bySize.entries()]
      .sort(([a], [b]) => (side === Side.Buy ? b - a : a - b))
      .map(([price, { size, count }]) => ({ price, size, count }));
  };

  test("matches depthDetailed after every step, with live bots", () => {
    const clock = new ManualClock();
    const sim = createExchangeSimulator({
      clock: clock.now,
      config: { activeInstruments: 5, mmRate: 40, takerRate: 30 },
    });
    const tables = createFakeTables();
    sim.attachTables(tables);
    const rebuilt = new Map<InstrumentBook, Rebuilt>();
    const lastSeq = new Map<InstrumentBook, number>();
    const types = new Map<EventType, number>();
    for (const book of sim.books) {
      rebuilt.set(book, new Map());
      lastSeq.set(book, 0);
      const next = book.bookEvents;
      book.bookEvents = {
        onBookEvent(b, e) {
          expect(e.seq).toBe((lastSeq.get(b) ?? 0) + 1);
          lastSeq.set(b, e.seq);
          types.set(e.type, (types.get(e.type) ?? 0) + 1);
          apply(rebuilt.get(b) as Rebuilt, e);
          next?.onBookEvent(b, e);
        },
        onBookReset(b) {
          next?.onBookReset(b);
        },
      };
    }
    for (let step = 0; step < 500; step++) {
      sim.step(clock.advance(20));
      if (step % 5 === 4) sim.flush();
      for (const book of sim.books) {
        const [asks, bids] = book.book.depthDetailed();
        const mine = rebuilt.get(book) as Rebuilt;
        expect(levels(mine, Side.Buy)).toEqual(bids);
        expect(levels(mine, Side.Sell)).toEqual(asks);
      }
    }
    // the flow exercised every event type except REDUCE (bots never amend down)
    for (const type of [Add, Execute, Delete]) {
      expect(types.get(type) ?? 0).toBeGreaterThan(100);
    }
    // and the coalesced bookOrders table agrees with the book
    sim.flush();
    const resting = sim.books.flatMap((b) => b.restingOrders());
    expect(tables.bookOrders.rowCount).toBe(resting.length);
    for (const o of resting) {
      expect(tables.bookOrders.get(o.id)?.size).toBe(o.size);
    }
  });
});
