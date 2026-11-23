import { describe, expect, test } from "bun:test";
import { BookEventType, Side } from "@heswell/trading-schemas";
import { type BookEvent, BookFeed, type SnapshotOrder } from "../src";

const { Add, Execute, Reset } = BookEventType;

const row = (
  orderId: string,
  price: number,
  size: number,
  priority: number,
  seq: number,
): SnapshotOrder => ({
  orderId,
  side: Side.Buy,
  price,
  size,
  entryTime: 0,
  priority,
  seq,
});

const ev = (
  seq: number,
  type: BookEventType,
  orderId: string,
  price: number,
  size: number,
  leaves: number,
): BookEvent => ({
  seq,
  type,
  orderId,
  side: type === Reset ? "" : Side.Buy,
  price,
  size,
  leaves,
  tradeId: "",
  timestamp: seq,
});

// the book at seq 3: a (seq 1), b (seq 3, after an execute at seq 2)
const rows = [row("a", 100, 10, 1, 1), row("b", 100, 15, 2, 3)];
const tape = [
  ev(1, Add, "a", 100, 10, 10),
  ev(2, Add, "b", 100, 20, 20),
  ev(3, Execute, "b", 100, 5, 15),
  ev(4, Add, "c", 99, 7, 7),
  ev(5, Execute, "a", 100, 10, 0),
];

const ids = (feed: BookFeed) =>
  feed.book
    .levels(Side.Buy)
    .map((l) => [l.price, l.orders.map((o) => o.orderId)]);

describe("BookFeed", () => {
  test("waits for a snapshot, then replays the buffer after its marker", () => {
    const feed = new BookFeed();
    feed.events(tape.slice().reverse()); // windows come newest first
    expect(feed.source).toBe("waiting");
    expect(feed.buffered).toBe(5);
    feed.snapshot(rows, { seq: 3, orders: 2 });
    expect(feed.source).toBe("events");
    expect(feed.book.seq).toBe(5);
    expect(ids(feed)).toEqual([
      [100, ["b"]],
      [99, ["c"]],
    ]);
    expect(feed.buffered).toBe(0);
    expect(feed.stats).toMatchObject({ events: 2, resyncs: 0 });
  });

  test("ignores a snapshot inconsistent with its marker", () => {
    const feed = new BookFeed();
    feed.snapshot(rows, { seq: 2, orders: 2 }); // a row newer than the marker
    feed.snapshot(rows, { seq: 3, orders: 3 }); // missing rows
    feed.snapshot(rows, undefined);
    expect(feed.source).toBe("waiting");
    feed.snapshot(rows, { seq: 3, orders: 2 });
    expect(feed.source).toBe("snapshot"); // no events seen yet
  });

  test("overlapping windows apply each event once", () => {
    const feed = new BookFeed();
    feed.snapshot(rows, { seq: 3, orders: 2 });
    feed.events(tape.slice(2, 4));
    feed.events(tape.slice(1, 5));
    expect(feed.book.seq).toBe(5);
    expect(feed.stats.events).toBe(2);
  });

  test("a gap waits for the next snapshot, then catches up", () => {
    const feed = new BookFeed();
    feed.snapshot(rows, { seq: 3, orders: 2 });
    feed.events([tape[4]]); // seq 5 without 4
    expect(feed.source).toBe("waiting");
    expect(feed.stats.gaps).toBe(1);
    // the snapshot at seq 4, then 5 from the buffer
    feed.snapshot([...rows, row("c", 99, 7, 3, 4)], { seq: 4, orders: 3 });
    expect(feed.source).toBe("events");
    expect(feed.book.seq).toBe(5);
    expect(feed.stats.resyncs).toBe(1);
    expect(ids(feed)).toEqual([
      [100, ["b"]],
      [99, ["c"]],
    ]);
  });

  test("a RESET waits for a snapshot at or after it", () => {
    const feed = new BookFeed();
    feed.snapshot(rows, { seq: 3, orders: 2 });
    feed.events([ev(4, Reset, "", 0, 0, 0), ev(5, Add, "z", 98, 1, 1)]);
    expect(feed.stats.resets).toBe(1);
    expect(feed.source).toBe("waiting");
    feed.snapshot([row("x", 101, 3, 9, 4)], { seq: 4, orders: 1 });
    expect(feed.book.seq).toBe(5);
    expect(ids(feed)).toEqual([
      [101, ["x"]],
      [98, ["z"]],
    ]);
  });

  test("a snapshot at the book's seq that differs twice in a row is loaded", () => {
    const feed = new BookFeed();
    feed.snapshot(rows, { seq: 3, orders: 2 });
    feed.events([tape[3]]); // seq 4 (c) once seen, so the source is events
    const other = [...rows, row("d", 99, 1, 5, 4)];
    feed.snapshot(other, { seq: 4, orders: 3 });
    expect(feed.stats.mismatches).toBe(0); // could be rows and marker out of step
    feed.snapshot(other, { seq: 4, orders: 3 });
    expect(feed.stats.mismatches).toBe(1);
    expect(feed.book.order("d")).toBeDefined();
    expect(feed.book.order("c")).toBeUndefined();
  });

  test("a matching snapshot clears a single mismatch", () => {
    const feed = new BookFeed();
    feed.snapshot(rows, { seq: 3, orders: 2 });
    feed.events([tape[3]]);
    feed.snapshot([...rows, row("d", 99, 1, 5, 4)], { seq: 4, orders: 3 });
    feed.snapshot([...rows, row("c", 99, 7, 3, 4)], { seq: 4, orders: 3 });
    feed.snapshot([...rows, row("d", 99, 1, 5, 4)], { seq: 4, orders: 3 });
    expect(feed.stats.mismatches).toBe(0);
  });

  test("with the tape off every newer snapshot is loaded", () => {
    const feed = new BookFeed();
    feed.snapshot(rows, { seq: 3, orders: 2 });
    feed.snapshot([row("a", 100, 10, 1, 1)], { seq: 6, orders: 1 });
    expect(feed.source).toBe("snapshot");
    expect(feed.book.seq).toBe(6);
    expect(feed.book.orderCount).toBe(1);
  });

  test("a snapshot ahead of the book gets one snapshot's grace for events", () => {
    const feed = new BookFeed();
    feed.snapshot(rows, { seq: 3, orders: 2 });
    feed.events([tape[2]]); // old event: the tape is on
    const ahead = [
      row("a", 100, 10, 1, 1),
      row("b", 100, 15, 2, 3),
      row("c", 99, 7, 3, 4),
    ];
    feed.snapshot(ahead, { seq: 4, orders: 3 });
    expect(feed.book.seq).toBe(3); // waits: event 4 may be on its way
    feed.snapshot(ahead, { seq: 4, orders: 3 });
    expect(feed.book.seq).toBe(4);
    expect(feed.stats.resyncs).toBe(1);
  });

  test("the buffer keeps the newest events", () => {
    const feed = new BookFeed({ maxBuffered: 2 });
    feed.events(tape);
    expect(feed.buffered).toBe(2);
    feed.snapshot([...rows, row("c", 99, 7, 3, 4)], { seq: 4, orders: 3 });
    expect(feed.book.seq).toBe(5);
  });
});
