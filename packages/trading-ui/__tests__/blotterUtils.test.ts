import { describe, expect, test } from "bun:test";
import {
  applySelectionChange,
  DONE_STATUSES,
  formatTime,
  isOrderAmendable,
  isOrderCancellable,
  orderBlotterTabFilter,
  rowsToCsv,
  sizePercentile,
  totalsByCurrency,
  WORKING_STATUSES,
} from "../src";

describe("order status helpers", () => {
  test("amend / cancel only for NEW, PARTIALLY_FILLED, REPLACED", () => {
    for (const s of ["NEW", "PARTIALLY_FILLED", "REPLACED"]) {
      expect(isOrderAmendable(s)).toBe(true);
      expect(isOrderCancellable(s)).toBe(true);
    }
    for (const s of [
      "PENDING_NEW",
      "PENDING_CANCEL",
      "PENDING_REPLACE",
      "FILLED",
      "CANCELLED",
      "REJECTED",
      "EXPIRED",
      undefined,
    ]) {
      expect(isOrderAmendable(s)).toBe(false);
      expect(isOrderCancellable(s)).toBe(false);
    }
  });

  test("tab filters cover working and closed statuses", () => {
    expect(WORKING_STATUSES).toContain("PENDING_CANCEL");
    expect(DONE_STATUSES).toEqual(["CANCELLED", "REJECTED", "EXPIRED"]);
    expect(orderBlotterTabFilter("working")).toContain('"PARTIALLY_FILLED"');
    expect(orderBlotterTabFilter("filled")).toBe('status in ["FILLED"]');
    expect(orderBlotterTabFilter("closed")).toContain('"EXPIRED"');
    expect(orderBlotterTabFilter("all")).toBe("");
  });
});

describe("applySelectionChange", () => {
  const keys = ["a", "b", "c", "d"];
  test("select, extend, range, deselect and clear", () => {
    let s: ReadonlySet<string> = new Set();
    s = applySelectionChange(
      s,
      { type: "SELECT_ROW", rowKey: "a", preserveExistingSelection: false },
      keys,
    );
    s = applySelectionChange(
      s,
      { type: "SELECT_ROW", rowKey: "c", preserveExistingSelection: true },
      keys,
    );
    expect([...s]).toEqual(["a", "c"]);
    s = applySelectionChange(
      s,
      {
        type: "SELECT_ROW_RANGE",
        fromRowKey: "b",
        toRowKey: "d",
        preserveExistingSelection: false,
      },
      keys,
    );
    expect([...s]).toEqual(["b", "c", "d"]);
    s = applySelectionChange(
      s,
      { type: "DESELECT_ROW", rowKey: "c", preserveExistingSelection: true },
      keys,
    );
    expect([...s]).toEqual(["b", "d"]);
    expect(applySelectionChange(s, { type: "DESELECT_ALL" }, keys).size).toBe(
      0,
    );
    expect(applySelectionChange(s, { type: "SELECT_ALL" }, keys).size).toBe(4);
  });
});

describe("csv / time / tape / totals", () => {
  test("rowsToCsv quotes and formats", () => {
    const csv = rowsToCsv(
      [{ name: "a" }, { name: "b", label: "B", format: (v) => `x${v}` }],
      [{ a: 'he said "hi", ok', b: 1 }],
    );
    expect(csv).toBe('a,B\r\n"he said ""hi"", ok",x1');
  });

  test("formatTime has milliseconds", () => {
    expect(formatTime(Date.UTC(2024, 0, 1, 14, 3, 7, 42), { utc: true })).toBe(
      "14:03:07.042",
    );
    expect(formatTime("x")).toBe("");
  });

  test("sizePercentile", () => {
    expect(sizePercentile([], 90)).toBe(Number.POSITIVE_INFINITY);
    expect(sizePercentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
  });

  test("totals are per currency", () => {
    const totals = totalsByCurrency([
      { currency: "USD", marketValue: 10, totalPnl: 1 },
      { currency: "GBX", marketValue: 5, totalPnl: -2 },
      { currency: "USD", marketValue: 20, totalPnl: 2 },
    ]);
    expect(totals.map((t) => t.currency)).toEqual(["GBX", "USD"]);
    expect(totals[1]).toMatchObject({
      positions: 2,
      marketValue: 30,
      totalPnl: 3,
    });
  });
});
