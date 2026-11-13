import { describe, expect, test } from "bun:test";
import {
  type BucketRow,
  bucketsToPoints,
  needsWindow,
  planRange,
  planWindow,
} from "../src/components/TimeSeriesChart/timeSeriesWindow";

const HOUR = 3_600_000;
const now = 1_763_000_000_000;

describe("planWindow", () => {
  test("overscan either side, one point per column, width on the 2^k ladder", () => {
    const plan = planWindow({
      start: now - 10 * HOUR,
      end: now - 9 * HOUR,
      widthPx: 1_000,
      baseMs: 1_000,
      follow: false,
    });
    expect(plan.start).toBe(now - 10.5 * HOUR);
    expect(plan.end).toBe(now - 8.5 * HOUR);
    expect(plan.points).toBe(2_000);
    // 2 h / 2000 columns = 3.6 s per column: the 2 s level
    expect(plan.width).toBe(2_000);
  });
  test("following: no overscan past now", () => {
    const plan = planWindow({
      start: now - HOUR,
      end: now,
      widthPx: 1_000,
      baseMs: 1_000,
      follow: true,
    });
    expect(plan.end).toBe(now);
    expect(plan.points).toBe(1_500);
    expect(planRange(plan, now + 5_000).to).toBeGreaterThan(now + 5_000);
  });
});

describe("needsWindow", () => {
  const view = {
    start: now - 2 * HOUR,
    end: now - HOUR,
    widthPx: 1_000,
    baseMs: 1_000,
    follow: false,
  };
  const plan = planWindow(view);
  const current = { ...plan, ...planRange(plan, now) };
  test("a pan inside the subscribed range needs nothing", () => {
    expect(
      needsWindow(
        current,
        { ...view, start: view.start + HOUR / 4, end: view.end + HOUR / 4 },
        0,
      ),
    ).toBe(false);
  });
  test("a zoom inside the width level needs nothing; to another level does", () => {
    expect(
      needsWindow(current, { ...view, end: view.end - HOUR / 10 }, 0),
    ).toBe(false);
    expect(needsWindow(current, { ...view, end: view.end + HOUR }, 0)).toBe(
      true,
    );
  });
  test("leaving the range does, unless there is no data there", () => {
    const left = { ...view, start: view.start - HOUR, end: view.end - HOUR };
    expect(needsWindow(current, left, 0)).toBe(true);
    expect(needsWindow(current, left, current.from)).toBe(false);
  });
  test("following changes do", () => {
    expect(needsWindow(current, { ...view, follow: true }, 0)).toBe(true);
  });
});

describe("bucketsToPoints", () => {
  const row = (bucket: number, extra: Partial<BucketRow> = {}): BucketRow => ({
    field: "mid",
    bucket,
    width: 1_000,
    firstT: bucket,
    first: 1,
    minT: bucket + 500,
    min: 0,
    maxT: bucket + 200,
    max: 3,
    lastT: bucket + 900,
    last: 2,
    ...extra,
  });
  test("first / max / min / last in time order, buckets sorted, gaps broken, stale widths skipped", () => {
    const pts = bucketsToPoints(
      [
        row(10_000),
        row(0),
        row(1_000, { width: 2_000 }),
        row(2_000, { minT: 2_000, min: 1 }),
      ],
      1_000,
      3_000,
    );
    expect(pts.mid).toEqual([
      [0, 1],
      [200, 3],
      [500, 0],
      [900, 2],
      [2_000, 1],
      [2_200, 3],
      [2_900, 2],
      [6_450, null],
      [10_000, 1],
      [10_200, 3],
      [10_500, 0],
      [10_900, 2],
    ]);
  });
});
