import { describe, expect, test } from "bun:test";
import { BookEventType, Side } from "@heswell/trading-schemas";
import {
  BookBuilder,
  type BookChange,
  type BookEvent,
  type BookOrder,
  queuePosition,
} from "../src";

const { Add, Execute, Reduce, Delete } = BookEventType;

const order = (
  orderId: string,
  side: Side,
  price: number,
  size: number,
  priority: number,
): BookOrder => ({ orderId, side, price, size, entryTime: priority, priority });

const event = (
  seq: number,
  type: BookEventType,
  orderId: string,
  side: Side,
  price: number,
  size: number,
  leaves: number,
): BookEvent => ({
  seq,
  type,
  orderId,
  side,
  price,
  size,
  leaves,
  tradeId: type === Execute ? `TR${seq}` : "",
  timestamp: 1_000 + seq,
});

const ids = (book: BookBuilder, side: Side, price: number) =>
  book.level(side, price)?.orders.map((o) => o.orderId);

const snapshot = [
  order("b1", Side.Buy, 100, 50, 1),
  order("b3", Side.Buy, 100, 10, 3),
  order("b2", Side.Buy, 100, 20, 2),
  order("b4", Side.Buy, 99.99, 5, 4),
  order("s1", Side.Sell, 100.05, 30, 5),
  order("s2", Side.Sell, 100.1, 40, 6),
];

const loaded = (seq = 10) => {
  const book = new BookBuilder();
  book.reset(snapshot, seq);
  return book;
};

describe("BookBuilder snapshot", () => {
  test("starts empty; reset loads levels best first, queues by priority", () => {
    const book = new BookBuilder();
    expect(book.status).toBe("empty");
    book.reset(snapshot, 10);
    expect(book.status).toBe("live");
    expect(book.seq).toBe(10);
    expect(book.orderCount).toBe(6);
    expect(
      book.levels(Side.Buy).map((l) => [l.price, l.total, l.count]),
    ).toEqual([
      [100, 80, 3],
      [99.99, 5, 1],
    ]);
    expect(book.levels(Side.Sell).map((l) => l.price)).toEqual([100.05, 100.1]);
    expect(book.levels(Side.Sell, 1).map((l) => l.price)).toEqual([100.05]);
    expect(ids(book, Side.Buy, 100)).toEqual(["b1", "b2", "b3"]);
  });

  test("order() gives rank and size ahead", () => {
    const book = loaded();
    expect(book.order("b3")).toMatchObject({ rank: 3, ahead: 70 });
    expect(book.order("b1")).toMatchObject({ rank: 1, ahead: 0 });
    expect(book.order("nope")).toBeUndefined();
    const level = book.level(Side.Buy, 100);
    expect(level && queuePosition(level, "b2")).toEqual({ rank: 2, ahead: 50 });
  });

  test("a second reset keeps unchanged levels and orders as the same objects", () => {
    const book = loaded();
    const bids = book.levels(Side.Buy);
    const asks = book.levels(Side.Sell);
    const best = book.level(Side.Buy, 100);
    const s1 = book.level(Side.Sell, 100.05);
    const changes: BookChange[] = [];
    book.subscribe((c) => changes.push(c));

    // same rows, new objects: nothing changes
    book.reset(
      snapshot.map((o) => ({ ...o })),
      11,
    );
    expect(changes).toEqual([]);
    expect(book.levels(Side.Buy)).toBe(bids);

    // one ask level changes
    book.reset(
      snapshot.map((o) => (o.orderId === "s2" ? { ...o, size: 35 } : o)),
      12,
    );
    expect(changes).toHaveLength(1);
    expect(changes[0].levels.map((l) => l.price)).toEqual([100.1]);
    expect(changes[0].orderIds).toEqual(["s2"]);
    expect(book.level(Side.Buy, 100)).toBe(best);
    expect(book.level(Side.Sell, 100.05)).toBe(s1);
    expect(book.levels(Side.Buy)).toBe(bids);
    expect(book.levels(Side.Sell)).not.toBe(asks);
  });

  test("reset removes missing orders and empty levels", () => {
    const book = loaded();
    const changes: BookChange[] = [];
    book.subscribe((c) => changes.push(c));
    book.reset(snapshot.filter((o) => o.orderId !== "b4"));
    expect(book.level(Side.Buy, 99.99)).toBeUndefined();
    expect(book.levels(Side.Buy).map((l) => l.price)).toEqual([100]);
    expect(changes[0].removed).toEqual([{ side: Side.Buy, price: 99.99 }]);
  });

  test("a new priority in a snapshot moves the order in its queue", () => {
    const book = loaded();
    book.reset(
      snapshot.map((o) => (o.orderId === "b1" ? { ...o, priority: 7 } : o)),
    );
    expect(ids(book, Side.Buy, 100)).toEqual(["b2", "b3", "b1"]);
  });

  test("the book keeps its own copies of snapshot rows", () => {
    const row = { ...order("x", Side.Buy, 1, 1, 1), extra: "vuu" };
    const book = new BookBuilder();
    book.reset([row]);
    row.size = 99;
    expect(book.order("x")?.order).toEqual(order("x", Side.Buy, 1, 1, 1));
  });
});

describe("BookBuilder events", () => {
  test("ADD joins the back of its level, after snapshot orders", () => {
    const book = loaded();
    expect(book.apply([event(11, Add, "b5", Side.Buy, 100, 15, 15)])).toBe(
      "ok",
    );
    expect(ids(book, Side.Buy, 100)).toEqual(["b1", "b2", "b3", "b5"]);
    expect(book.order("b5")).toMatchObject({ rank: 4, ahead: 80 });
    expect(book.order("b5")?.order.entryTime).toBe(1_011);
    expect(book.seq).toBe(11);
  });

  test("EXECUTE and REDUCE keep the order's place; leaves 0 removes it", () => {
    const book = loaded();
    const result = book.apply([
      event(11, Execute, "b1", Side.Buy, 100, 20, 30),
      event(12, Reduce, "b2", Side.Buy, 100, 5, 15),
      event(13, Execute, "s1", Side.Sell, 100.05, 30, 0),
    ]);
    expect(result).toBe("ok");
    expect(ids(book, Side.Buy, 100)).toEqual(["b1", "b2", "b3"]);
    expect(book.level(Side.Buy, 100)?.total).toBe(55);
    expect(book.level(Side.Sell, 100.05)).toBeUndefined();
    expect(book.levels(Side.Sell).map((l) => l.price)).toEqual([100.1]);
  });

  test("an amend that loses priority (DELETE then ADD) goes to the back", () => {
    const book = loaded();
    book.apply([
      event(11, Delete, "b1", Side.Buy, 100, 50, 0),
      event(12, Add, "b1", Side.Buy, 100, 60, 60),
    ]);
    expect(ids(book, Side.Buy, 100)).toEqual(["b2", "b3", "b1"]);
  });

  test("one notification per apply, with the changed levels and orders", () => {
    const book = loaded();
    const changes: BookChange[] = [];
    const unsubscribe = book.subscribe((c) => changes.push(c));
    book.apply([
      event(11, Execute, "s1", Side.Sell, 100.05, 30, 0),
      event(12, Add, "b5", Side.Buy, 100.02, 15, 15),
    ]);
    expect(changes).toHaveLength(1);
    expect(changes[0].levels.map((l) => l.price)).toEqual([100.02]);
    expect(changes[0].removed).toEqual([{ side: Side.Sell, price: 100.05 }]);
    expect(changes[0].orderIds).toEqual(["s1", "b5"]);
    unsubscribe();
    book.apply([event(13, Delete, "b5", Side.Buy, 100.02, 15, 0)]);
    expect(changes).toHaveLength(1);
  });

  test("events at or before seq are skipped", () => {
    const book = loaded();
    expect(
      book.apply([
        event(9, Add, "old", Side.Buy, 1, 1, 1),
        event(10, Add, "old", Side.Buy, 1, 1, 1),
        event(11, Add, "new", Side.Buy, 1, 1, 1),
      ]),
    ).toBe("ok");
    expect(book.order("old")).toBeUndefined();
    expect(book.order("new")).toBeDefined();
  });

  test("a seq gap stops, keeps what was applied and marks the book stale", () => {
    const book = loaded();
    const result = book.apply([
      event(11, Add, "b5", Side.Buy, 100, 1, 1),
      event(13, Add, "b6", Side.Buy, 100, 1, 1),
    ]);
    expect(result).toBe("gap");
    expect(book.status).toBe("stale");
    expect(book.seq).toBe(11);
    expect(book.order("b5")).toBeDefined();
    expect(book.order("b6")).toBeUndefined();
    // stale: nothing more is applied until a reset
    expect(book.apply([event(12, Add, "b6", Side.Buy, 100, 1, 1)])).toBe("gap");
    book.reset(snapshot, 20);
    expect(book.status).toBe("live");
    expect(book.apply([event(21, Add, "b6", Side.Buy, 100, 1, 1)])).toBe("ok");
  });

  test("an event that does not match the book is a gap", () => {
    const cases: BookEvent[] = [
      event(11, Execute, "nope", Side.Buy, 100, 1, 0), // unknown order
      event(11, Execute, "b1", Side.Buy, 99, 10, 40), // wrong price
      event(11, Execute, "b1", Side.Sell, 100, 10, 40), // wrong side
      event(11, Reduce, "b1", Side.Buy, 100, 10, 30), // sizes don't add up
      event(11, Add, "b1", Side.Buy, 100, 10, 10), // already resting
    ];
    for (const e of cases) {
      const book = loaded();
      expect({ e, result: book.apply([e]) }).toEqual({ e, result: "gap" });
    }
  });

  test("an empty book needs a reset before events", () => {
    const book = new BookBuilder();
    expect(book.apply([event(1, Add, "a", Side.Buy, 1, 1, 1)])).toBe("gap");
    book.reset([]);
    expect(book.apply([event(1, Add, "a", Side.Buy, 1, 1, 1)])).toBe("ok");
  });
});

describe("BookBuilder RESET", () => {
  const reset = (seq: number): BookEvent => ({
    seq,
    type: BookEventType.Reset,
    orderId: "",
    side: "",
    price: 0,
    size: 0,
    leaves: 0,
    tradeId: "",
    timestamp: 0,
  });

  test("a RESET applies the events before it, then marks the book stale", () => {
    const book = loaded();
    const result = book.apply([
      event(11, Add, "b5", Side.Buy, 100, 1, 1),
      reset(12),
      event(13, Add, "b6", Side.Buy, 100, 1, 1),
    ]);
    expect(result).toBe("reset");
    expect(book.status).toBe("stale");
    expect(book.seq).toBe(12);
    expect(book.order("b5")).toBeDefined();
    expect(book.order("b6")).toBeUndefined();
    // resync from the snapshot written at the RESET, then carry on
    book.reset(snapshot, 12);
    expect(book.apply([event(13, Add, "b6", Side.Buy, 100, 1, 1)])).toBe("ok");
    expect(book.order("b5")).toBeUndefined();
  });

  test("an ADD without a side is a gap", () => {
    const book = loaded();
    const bad = {
      ...event(11, Add, "x", Side.Buy, 100, 1, 1),
      side: "" as const,
    };
    expect(book.apply([bad])).toBe("gap");
  });
});
