/**
 * Time-series downsampling bench: server time, payload and visual error per
 * method, window and point budget, over one instrument with a week of 1 s
 * history (604,800 points per field).
 *
 *   bun packages/exchange-sim/scripts/timeseriesBench.ts [--days 7] [--width 1200]
 */
import {
  decodeTimeSeries,
  type DownsampleMethod,
} from "@heswell/trading-schemas";
import { lowerBound, m4Indices, scanMinMax } from "../src/history/downsample";
import { rasterError } from "../src/history/rasterError";
import { TimeSeriesStore } from "../src/history/TimeSeriesStore";

const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
};
const days = arg("days", 7);
const width = arg("width", 1200);
const height = 400;
const runs = arg("runs", 20);
const DAY = 86_400_000;
const now = Math.floor(Date.now() / 1000) * 1000;

const store = new TimeSeriesStore({
  intervalMs: 1000,
  historyMs: days * DAY,
  maxHistoryRics: 4,
  timeScale: 10,
  seed: 7,
  source: () => ({
    mid: 182.5,
    volatility: 0.3,
    tick: 0.01,
    decimals: 2,
    spreadBps: 3,
  }),
});

const heap0 = process.memoryUsage().heapUsed;
const g0 = performance.now();
const mid = store.series("AAPL.OQ", "mid", now);
const genMs = performance.now() - g0;
const heap1 = process.memoryUsage().heapUsed;
const stats = store.stats();
console.log(
  `history: ${mid.length.toLocaleString()} points per field, 2 fields, generated in ${genMs.toFixed(0)} ms`,
);
console.log(
  `memory: ${(stats.bytes / 1e6).toFixed(1)} MB held (${(stats.bytes / stats.points).toFixed(1)} B/point incl. pyramid ${(mid.pyramid.bytes / mid.length).toFixed(2)} B/point); heap +${((heap1 - heap0) / 1e6).toFixed(1)} MB`,
);

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

const windows = [
  ["1h", 3_600_000],
  ["1d", DAY],
  [`${days}d`, days * DAY],
] as const;
const methods: DownsampleMethod[] = ["m4", "minmaxlttb", "lttb", "raw"];
const budgets = [width, width * 4];

console.log(
  `\nwidth ${width}px × ${height}px; median of ${runs} runs; error = mean |Δ| of column extents (px), share of columns differing\n`,
);
console.log(
  "window | method     | points | source  | returned | server ms | JSON KB | gzip KB | err px | cols differ",
);
console.log(
  "------ | ---------- | ------ | ------- | -------- | --------- | ------- | ------- | ------ | -----------",
);
for (const [label, span] of windows) {
  // Snap the window to the pixel grid, as the chart does, so M4's buckets
  // (span / (points / 4)) fall on pixel columns.
  const pixelMs = Math.ceil(span / width);
  const start = Math.floor((now - span) / pixelMs) * pixelMs;
  const end = start + width * pixelMs;
  const lo = lowerBound(mid.times, start, 0, mid.length);
  const hi = lowerBound(mid.times, end, 0, mid.length);
  const full = {
    times: mid.times.subarray(lo, hi),
    values: mid.values.subarray(lo, hi),
  };
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const v of full.values) {
    if (v < yMin) yMin = v;
    if (v > yMax) yMax = v;
  }
  for (const points of budgets) {
    for (const method of methods) {
      const req = { ric: "AAPL.OQ", start, end, points, method };
      const times: number[] = [];
      let res = store.query(req, now);
      for (let r = 0; r < runs; r++) {
        const t0 = performance.now();
        res = store.query(req, now);
        JSON.stringify(res);
        times.push(performance.now() - t0);
      }
      const json = JSON.stringify(res);
      const gz = Bun.gzipSync(json).byteLength;
      const series = res.series[0];
      const decoded = decodeTimeSeries(series);
      const err = rasterError(full, decoded, {
        start: res.start,
        end: res.end,
        width,
        height,
        yMin,
        yMax,
      });
      console.log(
        [
          label.padEnd(6),
          method.padEnd(10),
          String(points).padStart(6),
          series.sourcePoints.toLocaleString().padStart(7),
          String(series.t.length).padStart(8),
          median(times).toFixed(2).padStart(9),
          (json.length / 1024).toFixed(1).padStart(7),
          (gz / 1024).toFixed(1).padStart(7),
          err.meanPx.toFixed(2).padStart(6),
          `${(err.columns * 100).toFixed(1)}%`.padStart(11),
        ].join(" | "),
      );
    }
  }
}

// What the pyramid buys: M4 bucket min/max by scanning every point instead.
console.log(
  "\nM4 min/max per bucket: pyramid vs scanning every point (ms, median)",
);
for (const [label, span] of windows) {
  const pixelMs = Math.ceil(span / width);
  const start = Math.floor((now - span) / pixelMs) * pixelMs;
  const end = start + width * pixelMs;
  const time = (minMax: Parameters<typeof m4Indices>[4]) => {
    const ts: number[] = [];
    for (let r = 0; r < runs; r++) {
      const t0 = performance.now();
      m4Indices(mid, start, end, pixelMs, minMax);
      ts.push(performance.now() - t0);
    }
    return median(ts).toFixed(2);
  };
  const scan = (lo: number, hi: number, out: [number, number]) =>
    scanMinMax(mid.values, lo, hi, out);
  console.log(
    `${label.padEnd(4)} pyramid ${time(mid.minMax)}  scan ${time(scan)}`,
  );
}
