import { describe, expect, test } from "bun:test";
import { decodeTimeSeries, validateRpcParams } from "@heswell/trading-schemas";
import {
  alignedBuckets,
  lowerBound,
  lttbIndices,
  m4Indices,
  MinMaxPyramid,
  minMaxIndices,
  rangeIndices,
  scanMinMax,
  withGaps,
} from "../src/history/downsample";
import { rasterError } from "../src/history/rasterError";
import { TimeSeries } from "../src/history/TimeSeries";
import {
  type HistorySource,
  TimeSeriesStore,
} from "../src/history/TimeSeriesStore";
import { Random } from "../src/util/random";

const walk = (n: number, seed = 1, step = 1000, t0 = 1_700_000_000_000) => {
  const rng = new Random(seed);
  const times = new Float64Array(n);
  const values = new Float64Array(n);
  let v = 100;
  for (let i = 0; i < n; i++) {
    times[i] = t0 + i * step;
    v += rng.normal() * 0.1 + (rng.chance(0.001) ? rng.normal() * 5 : 0);
    values[i] = v;
  }
  return { times, values, length: n };
};

describe("lowerBound", () => {
  const times = new Float64Array([10, 20, 20, 30]);
  test("finds the first index at or after t", () => {
    expect(lowerBound(times, 5, 0, 4)).toBe(0);
    expect(lowerBound(times, 20, 0, 4)).toBe(1);
    expect(lowerBound(times, 21, 0, 4)).toBe(3);
    expect(lowerBound(times, 31, 0, 4)).toBe(4);
  });
});

describe("MinMaxPyramid", () => {
  test("range queries match a scan (bulk build)", () => {
    const { values } = walk(20_000, 7);
    const p = new MinMaxPyramid(values);
    p.build(values.length);
    const rng = new Random(3);
    const a: [number, number] = [0, 0];
    const b: [number, number] = [0, 0];
    for (let k = 0; k < 500; k++) {
      const lo = rng.int(0, values.length - 2);
      const hi = rng.int(lo + 1, values.length);
      p.query(lo, hi, a);
      scanMinMax(values, lo, hi, b);
      expect(values[a[0]]).toBe(values[b[0]]);
      expect(values[a[1]]).toBe(values[b[1]]);
    }
  });

  test("appends (with growth) keep queries exact", () => {
    const { times, values } = walk(5_000, 11);
    const s = new TimeSeries(10_000, 16);
    for (let i = 0; i < values.length; i++) s.append(times[i], values[i]);
    expect(s.length).toBe(5_000);
    expect(s.pyramid.levels).toBeGreaterThan(5);
    const a: [number, number] = [0, 0];
    const b: [number, number] = [0, 0];
    for (const [lo, hi] of [
      [0, 5_000],
      [31, 4_097],
      [1_000, 1_001],
      [4_000, 5_000],
    ]) {
      s.pyramid.query(lo, hi, a);
      scanMinMax(s.values, lo, hi, b);
      expect(s.values[a[0]]).toBe(s.values[b[0]]);
      expect(s.values[a[1]]).toBe(s.values[b[1]]);
    }
  });

  test("memory is about half a byte per point", () => {
    const { values } = walk(100_000);
    const p = new MinMaxPyramid(values);
    expect(p.bytes / values.length).toBeLessThan(0.6);
  });
});

describe("m4Indices", () => {
  const data = walk(50_000, 5);
  const minMax = (lo: number, hi: number, out: [number, number]) =>
    scanMinMax(data.values, lo, hi, out);

  test("keeps first, min, max and last of every bucket, ascending", () => {
    const start = data.times[0];
    const end = data.times[data.length - 1] + 1;
    const bucketMs = 100_000; // 100 points per bucket
    const idx = m4Indices(data, start, end, bucketMs, minMax);
    expect(idx.length).toBeLessThanOrEqual(4 * 500);
    for (let i = 1; i < idx.length; i++)
      expect(idx[i]).toBeGreaterThan(idx[i - 1]);
    const set = new Set(idx);
    const { first, count } = alignedBuckets(start, end, bucketMs);
    const out: [number, number] = [0, 0];
    for (let b = 0; b < count; b++) {
      const lo = lowerBound(data.times, first + b * bucketMs, 0, data.length);
      const hi = lowerBound(
        data.times,
        first + (b + 1) * bucketMs,
        0,
        data.length,
      );
      if (hi <= lo) continue;
      scanMinMax(data.values, lo, hi, out);
      for (const i of [lo, hi - 1, out[0], out[1]])
        expect(set.has(i)).toBe(true);
    }
  });

  test("is pixel-exact when buckets are pixel columns", () => {
    const width = 800;
    const bucketMs = 50_000;
    const start = Math.ceil(data.times[0] / bucketMs) * bucketMs;
    const end = start + width * bucketMs;
    const idx = m4Indices(data, start, end, bucketMs, minMax);
    const lo = lowerBound(data.times, start, 0, data.length);
    const hi = lowerBound(data.times, end, 0, data.length);
    const full = {
      times: data.times.subarray(lo, hi),
      values: data.values.subarray(lo, hi),
    };
    const pick = (ix: number[]) => ({
      times: ix.map((i) => data.times[i]),
      values: ix.map((i) => data.values[i]),
    });
    let yMin = Infinity;
    let yMax = -Infinity;
    for (const v of full.values) {
      yMin = Math.min(yMin, v);
      yMax = Math.max(yMax, v);
    }
    const options = { start, end, width, height: 400, yMin, yMax };
    expect(rasterError(full, pick(idx), options).meanPx).toBe(0);
    // A stride (every k-th point) at the same count is visibly worse.
    const stride = Math.ceil((hi - lo) / idx.length);
    const strided: number[] = [];
    for (let i = lo; i < hi; i += stride) strided.push(i);
    expect(rasterError(full, pick(strided), options).meanPx).toBeGreaterThan(1);
  });

  test("buckets are aligned: overlapping windows pick the same points", () => {
    const bucketMs = 30_000;
    const t = data.times[0];
    const a = m4Indices(data, t + 1_000_000, t + 9_000_000, bucketMs, minMax);
    const b = m4Indices(data, t + 3_000_000, t + 12_000_000, bucketMs, minMax);
    const overlap = (ix: number[]) =>
      ix.filter(
        (i) => data.times[i] >= t + 3_030_000 && data.times[i] < t + 8_970_000,
      );
    expect(overlap(a)).toEqual(overlap(b));
  });

  test("empty buckets add nothing", () => {
    const times = new Float64Array([0, 1, 2, 1_000_000, 1_000_001]);
    const values = new Float64Array([1, 5, 2, 3, 4]);
    const s = { times, values, length: 5 };
    const idx = m4Indices(s, 0, 1_000_010, 10, (lo, hi, out) =>
      scanMinMax(values, lo, hi, out),
    );
    expect(idx).toEqual([0, 1, 2, 3, 4]);
  });
});

describe("lttbIndices", () => {
  test("keeps first, last and exactly threshold points", () => {
    const data = walk(10_000, 2);
    const idx = lttbIndices(data, rangeIndices(0, data.length), 500);
    expect(idx.length).toBe(500);
    expect(idx[0]).toBe(0);
    expect(idx[499]).toBe(9_999);
    for (let i = 1; i < idx.length; i++)
      expect(idx[i]).toBeGreaterThan(idx[i - 1]);
  });

  test("keeps a lone spike in a flat line", () => {
    const n = 1_000;
    const times = Float64Array.from({ length: n }, (_, i) => i);
    const values = new Float64Array(n);
    values[637] = 10;
    const idx = lttbIndices(
      { times, values, length: n },
      rangeIndices(0, n),
      20,
    );
    expect(idx).toContain(637);
  });

  test("returns the input when it is short", () => {
    const data = walk(10);
    expect(lttbIndices(data, [1, 2, 3], 10)).toEqual([1, 2, 3]);
  });

  test("MinMaxLTTB looks close to LTTB at a fraction of the input", () => {
    const data = walk(100_000, 9);
    const start = data.times[0];
    const end = data.times[data.length - 1] + 1;
    const points = 1_000;
    const minMax = (lo: number, hi: number, out: [number, number]) =>
      scanMinMax(data.values, lo, hi, out);
    const candidates = minMaxIndices(
      data,
      start,
      end,
      Math.ceil((end - start) / (points * 2)),
      minMax,
    );
    expect(candidates.length).toBeLessThanOrEqual(points * 4 + 2);
    const mm = lttbIndices(data, [0, ...candidates, data.length - 1], points);
    const full = lttbIndices(data, rangeIndices(0, data.length), points);
    const pick = (ix: number[]) => ({
      times: ix.map((i) => data.times[i]),
      values: ix.map((i) => data.values[i]),
    });
    const options = {
      start,
      end,
      width: 1_000,
      height: 400,
      yMin: Math.min(...data.values),
      yMax: Math.max(...data.values),
    };
    const all = { times: data.times, values: data.values };
    const eMm = rasterError(all, pick(mm), options).meanPx;
    const eFull = rasterError(all, pick(full), options).meanPx;
    expect(eMm).toBeLessThan(eFull * 1.5 + 0.5);
  });
});

describe("withGaps", () => {
  test("adds the points either side of a gap and breaks between them", () => {
    // gap between 49 and 50
    const { indices, breaks } = withGaps([0, 20, 70, 99], [50]);
    expect(indices).toEqual([0, 20, 49, 50, 70, 99]);
    expect([...breaks]).toEqual([3]);
  });
  test("no gaps in range", () => {
    expect(withGaps([10, 20], [5, 30]).breaks.size).toBe(0);
  });
});

describe("TimeSeriesStore", () => {
  const source: HistorySource = {
    mid: 100,
    volatility: 0.3,
    tick: 0.01,
    decimals: 2,
    spreadBps: 4,
  };
  const day = 86_400_000;
  const now = Math.floor(1_763_000_000_000 / 1000) * 1000;
  const store = () =>
    new TimeSeriesStore({
      intervalMs: 1000,
      historyMs: day,
      maxHistoryRics: 2,
      timeScale: 10,
      seed: 42,
      source: (ric) => (ric === "NOPE" ? undefined : source),
    });

  test("generates a day of history ending at the live points", () => {
    const s = store();
    s.sample(now, [{ ric: "AAA", bid: 99.9, ask: 100.1 }]);
    s.sample(now + 1000, [{ ric: "AAA", bid: 100, ask: 100.2 }]);
    const mid = s.series("AAA", "mid", now + 2000);
    expect(mid.length).toBe(86_400 + 2);
    expect(mid.times[86_399]).toBe(now - 1000);
    expect(mid.times[86_400]).toBe(now);
    expect(mid.gaps).toEqual([]);
    expect(mid.values[86_400]).toBe(100);
  });

  test("m4 answers a day-wide query within budget, with stats", () => {
    const s = store();
    const res = s.query(
      {
        ric: "AAA",
        points: 4_000,
        start: now - day,
        end: now,
        fields: "mid,spreadBps",
      },
      now,
    );
    expect(res.series).toHaveLength(2);
    for (const series of res.series) {
      expect(series.sourcePoints).toBe(86_400);
      expect(series.t.length).toBeLessThanOrEqual(4_000 + 2);
      expect(series.t.length).toBeGreaterThan(3_000);
      const { times } = decodeTimeSeries(series);
      for (let i = 1; i < times.length; i++)
        expect(times[i]).toBeGreaterThan(times[i - 1]);
    }
    expect(res.bucketMs).toBe(Math.ceil(day / 1_000));
    expect(res.serverMs).toBeGreaterThanOrEqual(0);
  });

  test("every method stays within the point budget", () => {
    const s = store();
    for (const method of ["m4", "minmaxlttb", "lttb", "raw"] as const) {
      const res = s.query(
        { ric: "AAA", points: 1_000, start: now - day, end: now, method },
        now,
      );
      expect(res.series[0].t.length).toBeLessThanOrEqual(1_002);
      expect(res.series[0].t.length).toBeGreaterThan(400);
    }
  });

  test("a pause in live sampling is a null in the response", () => {
    const s = store();
    s.sample(now, [{ ric: "AAA", bid: 99.9, ask: 100.1 }]);
    s.query({ ric: "AAA", points: 100 }, now + 1000); // generates history
    s.sample(now + 60_000, [{ ric: "AAA", bid: 100, ask: 100.2 }]);
    s.sample(now + 61_000, [{ ric: "AAA", bid: 100, ask: 100.2 }]);
    const res = s.query(
      { ric: "AAA", points: 400, start: now - 10_000, end: now + 62_000 },
      now + 62_000,
    );
    const { times, values } = decodeTimeSeries(res.series[0]);
    const gap = values.indexOf(null);
    expect(gap).toBeGreaterThan(0);
    expect(times[gap - 1]).toBe(now);
    expect(times[gap + 1]).toBe(now + 60_000);
  });

  test("keeps history for at most maxHistoryRics instruments", () => {
    const s = store();
    for (const ric of ["A", "B", "C"]) s.query({ ric, points: 100 }, now);
    expect(s.stats().withHistory).toBe(2);
    expect(() => s.query({ ric: "NOPE", points: 100 }, now)).toThrow();
  });

  test("params are validated", () => {
    expect(validateRpcParams("timeSeries", { ric: "A", points: 2 }).ok).toBe(
      false,
    );
    expect(
      validateRpcParams("timeSeries", { ric: "A", points: 100, method: "m4" })
        .ok,
    ).toBe(true);
  });
});
