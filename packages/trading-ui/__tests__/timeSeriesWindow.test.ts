import { describe, expect, test } from "bun:test";
import type { TimeSeriesResponse } from "@heswell/trading-schemas";
import {
  type LoadedWindow,
  mergeTail,
  needsRequest,
  planRequest,
  tailStart,
} from "../src/components/TimeSeriesChart/timeSeriesWindow";

const HOUR = 3_600_000;
const now = 1_763_000_000_000;

describe("planRequest", () => {
  test("m4: one bucket per pixel, overscan, snapped to the pixel grid", () => {
    const view = {
      start: now - 10 * HOUR,
      end: now - 9 * HOUR,
      widthPx: 1_000,
      method: "m4" as const,
      now,
    };
    const plan = planRequest(view);
    expect(plan.pixelMs).toBe(3_600);
    expect(plan.bucketMs).toBe(3_600);
    expect(plan.start % 3_600).toBe(0);
    expect(plan.end % 3_600).toBe(0);
    expect(plan.start).toBeLessThanOrEqual(view.start - HOUR / 2);
    expect(plan.end).toBeGreaterThanOrEqual(view.end + HOUR / 2);
    expect(plan.points).toBe(4 * ((plan.end - plan.start) / 3_600));
  });
  test("does not overscan past the live edge", () => {
    const plan = planRequest({
      start: now - HOUR,
      end: now,
      widthPx: 1_000,
      method: "lttb",
      now,
    });
    expect(plan.end).toBeLessThanOrEqual(now + 2 * plan.pixelMs);
    expect(plan.bucketMs).toBeUndefined();
    expect(plan.points).toBe(
      2 * Math.round((plan.end - plan.start) / plan.pixelMs),
    );
  });
  test("caps the point budget", () => {
    expect(
      planRequest({ start: 0, end: HOUR, widthPx: 20_000, method: "m4", now })
        .points,
    ).toBe(20_000);
  });
});

describe("needsRequest", () => {
  const loaded: LoadedWindow = {
    start: now - 3 * HOUR,
    end: now,
    pixelMs: 3_600,
    method: "m4",
    series: {},
  };
  const view = {
    start: now - 2 * HOUR,
    end: now - HOUR,
    widthPx: 1_000,
    method: "m4" as const,
    now,
  };
  test("a pan inside the loaded range needs nothing", () => {
    expect(needsRequest(loaded, view, 0)).toBe(false);
  });
  test("zooming past 10% does", () => {
    expect(needsRequest(loaded, { ...view, end: view.end + HOUR / 5 }, 0)).toBe(
      true,
    );
  });
  test("panning out of the range does, unless there is no data there", () => {
    const left = { ...view, start: now - 3.5 * HOUR, end: now - 2.5 * HOUR };
    expect(needsRequest(loaded, left, 0)).toBe(true);
    expect(needsRequest(loaded, left, now - 3 * HOUR)).toBe(false);
  });
  test("a method change does", () => {
    expect(needsRequest(loaded, { ...view, method: "lttb" }, 0)).toBe(true);
  });
});

describe("mergeTail", () => {
  test("replaces the last bucket with the tail's points", () => {
    const loaded: LoadedWindow = {
      start: 0,
      end: 3_000,
      pixelMs: 1_000,
      method: "m4",
      series: {
        mid: [
          [0, 1],
          [999, 2],
          [1_000, 3],
          [2_000, 4],
          [2_400, 5],
        ],
      },
    };
    const from = tailStart(loaded);
    expect(from).toBe(2_000);
    const tail = {
      end: 4_000,
      series: [
        {
          field: "mid",
          t0: 1_000,
          t: [0, 1_000, 500, 1_000],
          v: [3, 4, 6, 7],
          sourcePoints: 4,
        },
      ],
    } as unknown as TimeSeriesResponse;
    const merged = mergeTail(loaded, tail, from);
    expect(merged.series.mid).toEqual([
      [0, 1],
      [999, 2],
      [1_000, 3],
      [2_000, 4],
      [2_500, 6],
      [3_500, 7],
    ]);
    expect(merged.end).toBe(4_000);
  });
});
