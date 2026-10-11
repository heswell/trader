import { describe, expect, test } from "bun:test";
import {
  ORD_STATUSES,
  ORDER_STATUS_TRANSITIONS,
  OrdStatus,
  assertTransition,
  canAmend,
  canCancel,
  canTransition,
  isPendingStatus,
  isTerminalStatus,
  workingStatusFor,
} from "../src";

describe("order status transitions", () => {
  test("every status has an entry; targets are valid statuses", () => {
    for (const status of ORD_STATUSES) {
      const targets = ORDER_STATUS_TRANSITIONS[status];
      expect(targets).toBeDefined();
      for (const t of targets) expect(ORD_STATUSES).toContain(t);
    }
  });

  test("terminal statuses", () => {
    expect(ORD_STATUSES.filter(isTerminalStatus).sort()).toEqual(
      [
        OrdStatus.Cancelled,
        OrdStatus.Expired,
        OrdStatus.Filled,
        OrdStatus.Rejected,
      ].sort(),
    );
  });

  test("every non-terminal status can reach a terminal status", () => {
    for (const start of ORD_STATUSES) {
      const seen = new Set([start]);
      const queue = [start];
      while (queue.length) {
        for (const next of ORDER_STATUS_TRANSITIONS[
          queue.shift() as OrdStatus
        ]) {
          if (!seen.has(next)) {
            seen.add(next);
            queue.push(next);
          }
        }
      }
      expect([...seen].some(isTerminalStatus)).toBe(true);
    }
  });

  test("lifecycle paths", () => {
    const path = (...s: OrdStatus[]) =>
      s.every((x, i) => i === 0 || canTransition(s[i - 1], x));
    const S = OrdStatus;
    expect(path(S.PendingNew, S.New, S.PartiallyFilled, S.Filled)).toBe(true);
    expect(path(S.PendingNew, S.Rejected)).toBe(true);
    expect(path(S.New, S.PendingCancel, S.Cancelled)).toBe(true);
    expect(path(S.New, S.PendingCancel, S.Filled)).toBe(true);
    expect(path(S.New, S.PendingReplace, S.Replaced, S.PendingReplace)).toBe(
      true,
    );
    expect(path(S.PartiallyFilled, S.PendingReplace, S.PartiallyFilled)).toBe(
      true,
    );
    expect(path(S.New, S.Expired)).toBe(true);
  });

  test("illegal transitions", () => {
    expect(canTransition(OrdStatus.PendingNew, OrdStatus.Filled)).toBe(false);
    expect(canTransition(OrdStatus.Filled, OrdStatus.Cancelled)).toBe(false);
    expect(canTransition(OrdStatus.PartiallyFilled, OrdStatus.New)).toBe(false);
    expect(
      canTransition(OrdStatus.PendingCancel, OrdStatus.PendingReplace),
    ).toBe(false);
    expect(() => assertTransition(OrdStatus.Rejected, OrdStatus.New)).toThrow();
  });

  test("helpers", () => {
    expect(canCancel(OrdStatus.New)).toBe(true);
    expect(canAmend(OrdStatus.PendingCancel)).toBe(false);
    expect(canCancel(OrdStatus.Filled)).toBe(false);
    expect(isPendingStatus(OrdStatus.PendingReplace)).toBe(true);
    expect(workingStatusFor(0, false)).toBe(OrdStatus.New);
    expect(workingStatusFor(0, true)).toBe(OrdStatus.Replaced);
    expect(workingStatusFor(10, true)).toBe(OrdStatus.PartiallyFilled);
  });
});
