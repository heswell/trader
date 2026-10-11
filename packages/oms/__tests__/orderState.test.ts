import { describe, expect, test } from "bun:test";
import { OrdStatus, RejectReason } from "@heswell/trading-schemas";
import {
  newOrderState,
  OrderStateError,
  reduceOrder,
  reduceOrderEvents,
} from "../src/domain/orderState";

const acked = () => reduceOrder(newOrderState(100, 10), { type: "ack" });

describe("order state machine", () => {
  test("starts PENDING_NEW with all quantity leaving", () => {
    expect(newOrderState(100, 10)).toMatchObject({
      status: OrdStatus.PendingNew,
      quantity: 100,
      cumQty: 0,
      leavesQty: 100,
      version: 0,
    });
    expect(() => newOrderState(0, 10)).toThrow();
  });

  test("PendingNew -> New -> PartiallyFilled -> Filled with avgPx", () => {
    const s = reduceOrderEvents(newOrderState(100, 10), [
      { type: "ack" },
      { type: "fill", qty: 40, px: 10 },
    ]);
    expect(s).toMatchObject({
      status: OrdStatus.PartiallyFilled,
      cumQty: 40,
      leavesQty: 60,
      avgPx: 10,
      lastQty: 40,
      lastPx: 10,
    });
    const done = reduceOrder(s, { type: "fill", qty: 60, px: 9.5 });
    expect(done).toMatchObject({
      status: OrdStatus.Filled,
      cumQty: 100,
      leavesQty: 0,
      lastQty: 60,
      lastPx: 9.5,
    });
    expect(done.avgPx).toBeCloseTo(9.7, 10);
  });

  test("reject from PendingNew records reason and text", () => {
    const s = reduceOrder(newOrderState(100, 10), {
      type: "reject",
      reason: RejectReason.ExceedsMaxQuantity,
      text: "too big",
    });
    expect(s).toMatchObject({
      status: OrdStatus.Rejected,
      leavesQty: 0,
      rejectReason: RejectReason.ExceedsMaxQuantity,
      text: "too big",
    });
  });

  test("illegal transitions throw OrderStateError", () => {
    const fresh = newOrderState(100, 10);
    expect(() => reduceOrder(fresh, { type: "fill", qty: 1, px: 10 })).toThrow(
      OrderStateError,
    );
    expect(() => reduceOrder(fresh, { type: "pendingCancel" })).toThrow(
      OrderStateError,
    );
    const filled = reduceOrder(acked(), { type: "fill", qty: 100, px: 10 });
    expect(() => reduceOrder(filled, { type: "pendingCancel" })).toThrow(
      OrderStateError,
    );
    expect(() => reduceOrder(filled, { type: "ack" })).toThrow(OrderStateError);
    const cancelled = reduceOrderEvents(acked(), [
      { type: "pendingCancel" },
      { type: "cancelled" },
    ]);
    expect(() =>
      reduceOrder(cancelled, { type: "fill", qty: 1, px: 10 }),
    ).toThrow(OrderStateError);
    const pc = reduceOrder(acked(), { type: "pendingCancel" });
    expect(() =>
      reduceOrder(pc, { type: "pendingReplace", quantity: 50, price: 10 }),
    ).toThrow(OrderStateError);
  });

  test("overfill throws", () => {
    expect(() =>
      reduceOrder(acked(), { type: "fill", qty: 101, px: 10 }),
    ).toThrow();
  });

  test("cancel: PendingCancel -> Cancelled zeroes leaves", () => {
    const s = reduceOrderEvents(acked(), [
      { type: "fill", qty: 30, px: 10 },
      { type: "pendingCancel" },
    ]);
    expect(s.status).toBe(OrdStatus.PendingCancel);
    const c = reduceOrder(s, { type: "cancelled" });
    expect(c).toMatchObject({
      status: OrdStatus.Cancelled,
      cumQty: 30,
      leavesQty: 0,
    });
  });

  test("fill during PendingCancel keeps PendingCancel; completing fill wins", () => {
    const pc = reduceOrder(acked(), { type: "pendingCancel" });
    const partial = reduceOrder(pc, { type: "fill", qty: 40, px: 10 });
    expect(partial).toMatchObject({
      status: OrdStatus.PendingCancel,
      cumQty: 40,
      leavesQty: 60,
    });
    const filled = reduceOrder(partial, { type: "fill", qty: 60, px: 10 });
    expect(filled.status).toBe(OrdStatus.Filled);
    // the cancel reject (TOO_LATE) arriving afterwards is ignored
    expect(
      reduceOrder(filled, {
        type: "cancelReject",
        reason: RejectReason.TooLateToCancel,
      }),
    ).toBe(filled);
  });

  test("cancel reject restores the working status", () => {
    const s = reduceOrderEvents(acked(), [
      { type: "fill", qty: 10, px: 10 },
      { type: "pendingCancel" },
      { type: "cancelReject", reason: RejectReason.TooLateToCancel },
    ]);
    expect(s.status).toBe(OrdStatus.PartiallyFilled);
  });

  test("amend: PendingReplace -> Replaced bumps version and applies qty/price", () => {
    const pr = reduceOrder(acked(), {
      type: "pendingReplace",
      quantity: 200,
      price: 11,
    });
    expect(pr).toMatchObject({
      status: OrdStatus.PendingReplace,
      quantity: 100,
      pendingAmend: { quantity: 200, price: 11 },
    });
    const r = reduceOrder(pr, { type: "replaced", quantity: 200, price: 11 });
    expect(r).toMatchObject({
      status: OrdStatus.Replaced,
      quantity: 200,
      price: 11,
      leavesQty: 200,
      version: 1,
      amended: true,
    });
    expect(r.pendingAmend).toBeUndefined();
    // a later partial fill on an amended order
    expect(reduceOrder(r, { type: "fill", qty: 50, px: 11 }).status).toBe(
      OrdStatus.PartiallyFilled,
    );
  });

  test("partial fill during PendingReplace, then replace applies on top", () => {
    const s = reduceOrderEvents(acked(), [
      { type: "pendingReplace", quantity: 80, price: 10 },
      { type: "fill", qty: 30, px: 10 },
    ]);
    expect(s).toMatchObject({
      status: OrdStatus.PendingReplace,
      cumQty: 30,
      leavesQty: 70,
    });
    const r = reduceOrder(s, { type: "replaced", quantity: 80, price: 10 });
    expect(r).toMatchObject({ cumQty: 30, leavesQty: 50, version: 1 });
  });

  test("amend down to cumQty completes the order", () => {
    const s = reduceOrderEvents(acked(), [
      { type: "fill", qty: 30, px: 10 },
      { type: "pendingReplace", quantity: 30, price: 10 },
      { type: "replaced", quantity: 30, price: 10 },
    ]);
    expect(s).toMatchObject({
      status: OrdStatus.Filled,
      leavesQty: 0,
      version: 1,
    });
  });

  test("replace reject restores the prior working status and quantity", () => {
    const s = reduceOrderEvents(acked(), [
      { type: "pendingReplace", quantity: 200, price: 11 },
      { type: "replaceReject", reason: RejectReason.PriceOutsideCollar },
    ]);
    expect(s).toMatchObject({
      status: OrdStatus.New,
      quantity: 100,
      price: 10,
    });
    expect(s.pendingAmend).toBeUndefined();
  });

  test("expired from New / PartiallyFilled", () => {
    const e = reduceOrderEvents(acked(), [
      { type: "fill", qty: 20, px: 10 },
      { type: "expired", reason: RejectReason.NoLiquidity, text: "IOC" },
    ]);
    expect(e).toMatchObject({
      status: OrdStatus.Expired,
      cumQty: 20,
      leavesQty: 0,
      rejectReason: RejectReason.NoLiquidity,
    });
  });
});
