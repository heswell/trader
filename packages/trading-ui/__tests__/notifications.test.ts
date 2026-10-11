import { describe, expect, test } from "bun:test";
import { OrdStatus, Side } from "@heswell/trading-schemas";
import {
  describeOrderEvent,
  FillEventTracker,
  NotificationGate,
  orderEventKey,
  ParentOrderEventTracker,
  type TradingOrderEvent,
  toConnectionState,
} from "../src";

const fakeTimers = () => {
  let now = 0;
  const timers: { at: number; fn: () => void }[] = [];
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      const t = { at: now + ms, fn };
      timers.push(t);
      return t;
    },
    clearTimer: (t: unknown) => {
      const i = timers.indexOf(t as (typeof timers)[number]);
      if (i >= 0) timers.splice(i, 1);
    },
    advance(ms: number) {
      now += ms;
      for (const t of timers.filter((t) => t.at <= now)) {
        timers.splice(timers.indexOf(t), 1);
        t.fn();
      }
    },
  };
};

const fill = (n: number): TradingOrderEvent => ({
  kind: "fill",
  execId: `E${n}`,
  orderId: "O1",
  ric: "VOD.L",
  side: Side.Buy,
  fillQty: 100,
  fillPx: 100,
});

describe("NotificationGate", () => {
  test("dedupes by event key within the window", () => {
    const clock = fakeTimers();
    const shown: TradingOrderEvent[] = [];
    const gate = new NotificationGate({
      ...clock,
      dedupeMs: 1000,
      emit: (e) => shown.push(e),
      emitSummary: () => {},
    });
    expect(gate.offer(fill(1))).toBe(true);
    expect(gate.offer(fill(1))).toBe(false);
    clock.advance(1001);
    expect(gate.offer(fill(1))).toBe(true);
    expect(shown).toHaveLength(2);
    expect(orderEventKey(fill(1))).toBe("fill:E1");
    expect(orderEventKey({ kind: "ack", clOrdId: "C1", orderId: "O1" })).toBe(
      "ack:C1",
    );
  });

  test("rate limits bursts and summarises the suppressed events", () => {
    const clock = fakeTimers();
    const shown: TradingOrderEvent[] = [];
    const summaries: unknown[] = [];
    const gate = new NotificationGate({
      ...clock,
      rateLimit: { max: 3, perMs: 1000 },
      emit: (e) => shown.push(e),
      emitSummary: (s) => summaries.push(s),
    });
    for (let i = 0; i < 10; i++) gate.offer(fill(i));
    expect(shown).toHaveLength(3);
    expect(summaries).toHaveLength(0);
    clock.advance(1000);
    expect(summaries).toEqual([{ fill: 7 }]);
    gate.dispose();
  });
});

describe("order event trackers", () => {
  test("parent orders: snapshot is silent, later changes produce events", () => {
    const tracker = new ParentOrderEventTracker();
    expect(tracker.update([], 5)).toEqual([]);
    expect(
      tracker.update([
        {
          orderId: "O1",
          clOrdId: "C1",
          status: OrdStatus.New,
          lastUpdate: 100,
          ric: "VOD.L",
          side: Side.Buy,
          quantity: 100,
        },
      ]),
    ).toEqual([]);
    const events = tracker.update([
      {
        orderId: "O1",
        clOrdId: "C1",
        status: OrdStatus.Filled,
        lastUpdate: 200,
        ric: "VOD.L",
        side: Side.Buy,
        quantity: 100,
      },
      {
        orderId: "O2",
        clOrdId: "C2",
        status: OrdStatus.Rejected,
        lastUpdate: 210,
        ric: "VOD.L",
        side: Side.Sell,
        quantity: 100,
        rejectReason: "PRICE_OUTSIDE_COLLAR",
        text: "too far",
      },
      { orderId: "O0", status: OrdStatus.New, lastUpdate: 50 },
    ]);
    expect(events.map((e) => [e.kind, e.orderId])).toEqual([
      ["filled", "O1"],
      ["reject", "O2"],
    ]);
    // no status change → no event
    expect(
      tracker.update([
        { orderId: "O1", status: OrdStatus.Filled, lastUpdate: 200 },
      ]),
    ).toEqual([]);
  });

  test("fills: snapshot silent, new execIds toast once", () => {
    const tracker = new FillEventTracker();
    expect(
      tracker.update([{ execId: "E1", orderId: "O1", timestamp: 100 }]),
    ).toEqual([]);
    const events = tracker.update([
      {
        execId: "E2",
        orderId: "O1",
        timestamp: 150,
        ric: "VOD.L",
        side: Side.Buy,
        quantity: 100,
        price: 100,
      },
      { execId: "E1", orderId: "O1", timestamp: 100 },
    ]);
    expect(events.map((e) => e.execId)).toEqual(["E2"]);
    expect(tracker.update([{ execId: "E2", timestamp: 150 }])).toEqual([]);
    const text = describeOrderEvent(events[0]);
    expect(text.header).toBeString();
    expect(text.status).toBeString();
  });
});

describe("toConnectionState", () => {
  test("maps vuu connection statuses", () => {
    expect(toConnectionState("connected")).toBe("connected");
    expect(toConnectionState("reconnected")).toBe("connected");
    expect(toConnectionState("reconnecting")).toBe("reconnecting");
    expect(toConnectionState("connection-failed")).toBe("failed");
    expect(toConnectionState("disconnected")).toBe("disconnected");
    expect(toConnectionState(undefined)).toBe("disconnected");
  });
});
