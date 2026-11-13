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
import { TimeSeries } from "../src/history/TimeSeries";
import {
  type BucketValue,
  BucketWindow,
  bucketsIn,
  SeriesSource,
} from "../src/history/BucketWindow";

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
  tree: false,
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
const midSource = new SeriesSource(mid);
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

// ------------------------------------------------------------ subscription model
// Buckets on the base × 2^k ladder (≤ one pixel wide), as the timeSeriesBuckets rows.
console.log(
  "\nSubscription (BucketWindow): one bucket per column (≤ 1 px wide), window = view + 50% overscan each side",
);
console.log(
  "window | width ms | buckets | setWindow ms | err px | cols | 2/px: err px, cols | pan 10%: rows ±, ms | zoom 5%: rows | zoom out 1.5x: rows",
);
const toPoints = (rows: BucketValue[]) => {
  const times: number[] = [];
  const values: number[] = [];
  for (const r of rows) {
    const four = [
      [r.firstT, r.first],
      [r.minT, r.min],
      [r.maxT, r.max],
      [r.lastT, r.last],
    ].sort((a, b) => a[0] - b[0]);
    for (let i = 0; i < 4; i++)
      if (i === 0 || four[i][0] !== four[i - 1][0]) {
        times.push(four[i][0]);
        values.push(four[i][1]);
      }
  }
  return { times, values };
};
for (const [label, span] of windows) {
  // mid-history where there is room (pans then add and remove)
  const end = span * 3 <= days * DAY ? now - span : now;
  const start = end - span;
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
  const spec = {
    start: start - span / 2,
    end: end + span / 2,
    points: width * 2,
  };
  const ts: number[] = [];
  let w = new BucketWindow(["mid"], () => midSource, 1000);
  let first = w.setWindow(spec, now);
  for (let r = 0; r < runs; r++) {
    w = new BucketWindow(["mid"], () => midSource, 1000);
    const t0 = performance.now();
    first = w.setWindow(spec, now);
    ts.push(performance.now() - t0);
  }
  const width0 = first.width;
  const visible = bucketsIn(
    mid,
    Math.floor(start / width0) * width0,
    end,
    width0,
  );
  const raster = { start, end, width, height, yMin, yMax };
  const err = rasterError(full, toPoints(visible), raster);
  const width2 = new BucketWindow(["mid"], () => midSource, 1000).setWindow(
    { ...spec, points: width * 4 },
    now,
  ).width;
  const err2 = rasterError(
    full,
    toPoints(bucketsIn(mid, Math.floor(start / width2) * width2, end, width2)),
    raster,
  );
  const shift = span / 10;
  const p0 = performance.now();
  const pan = w.setWindow(
    { ...spec, start: spec.start - shift, end: spec.end - shift },
    now,
  );
  const panMs = performance.now() - p0;
  const inLevel = w.setWindow(
    { ...spec, start: spec.start - shift, end: spec.end - shift - span * 0.05 },
    now,
  );
  const nextLevel = w.setWindow(
    { ...spec, start: spec.start - shift - span, end: spec.end - shift },
    now,
  );
  console.log(
    [
      label.padEnd(6),
      String(width0).padStart(8),
      String(first.upserts.length).padStart(7),
      median(ts).toFixed(2).padStart(12),
      err.meanPx.toFixed(2).padStart(6),
      `${(err.columns * 100).toFixed(1)}%`.padStart(5),
      `${err2.meanPx.toFixed(2)}, ${(err2.columns * 100).toFixed(1)}%`.padStart(
        17,
      ),
      `+${pan.upserts.length} / −${pan.removed.length}, ${panMs.toFixed(2)}`.padStart(
        20,
      ),
      `+${inLevel.upserts.length} / −${inLevel.removed.length}${inLevel.reset ? " (reset)" : ""}`.padStart(
        14,
      ),
      `+${nextLevel.upserts.length} / −${nextLevel.removed.length}${nextLevel.reset ? " (reset)" : ""}`.padStart(
        24,
      ),
    ].join(" | "),
  );
}

// Ticks: N following subscriptions, one new point per second each.
{
  const live = new TimeSeries(3_000, 1 << 20);
  const liveSource = new SeriesSource(live);
  for (let i = 0; i < 86_400; i++)
    live.append(now - 86_400_000 + i * 1000, 100 + Math.sin(i / 300));
  const subs = 200;
  const ws = Array.from(
    { length: subs },
    () => new BucketWindow(["mid"], () => liveSource, 1000),
  );
  for (const w of ws)
    w.setWindow(
      { start: now - 3_600_000, end: now, points: 1800, follow: true },
      now,
    );
  let t = now;
  const ts: number[] = [];
  let changed = 0;
  for (let k = 0; k < 60; k++) {
    t += 1000;
    live.append(t, 100 + Math.random());
    const t0 = performance.now();
    for (const w of ws) {
      const d = w.tick(t + 1);
      changed += d.upserts.length + d.removed.length;
    }
    ts.push(performance.now() - t0);
  }
  console.log(
    `\nticks: ${subs} following 1h subscriptions, 1 point/s for 60 s: ${median(ts).toFixed(2)} ms per tick for all (${((median(ts) / subs) * 1000).toFixed(1)} µs each), ${(changed / 60 / subs).toFixed(2)} row changes per subscription per tick`,
  );
  const row = [
    "s-abc|mid|1763000000000",
    "s-abc",
    "AAPL.OQ",
    "mid",
    1763000000000,
    2000,
    2,
    1763000000000,
    182.345,
    1763000001000,
    182.34,
    1763000000000,
    182.345,
    1763000001000,
    182.34,
  ];
  console.log(
    `a bucket row as JSON values: ${JSON.stringify(row).length} bytes (vs ~13 bytes per point in the RPC encoding, up to 4 points per bucket)`,
  );
}

// Five years as a HistoryTree: range presets, a pan, and a drill-down.
{
  const YEAR = 365.25 * DAY;
  const longStore = () =>
    new TimeSeriesStore({
      intervalMs: 1000,
      historyMs: 5 * YEAR,
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
  const s0 = longStore();
  const g0 = performance.now();
  const src = s0.source("AAPL.OQ", "mid", now);
  s0.source("AAPL.OQ", "spreadBps", now);
  const gen = performance.now() - g0;
  const st = s0.stats();
  console.log(
    `\nfive years (tree): ${((src.length * 2) / 1e6).toFixed(0)} M points over 2 fields; history ready in ${gen.toFixed(0)} ms (stored tail ${src.stored.length.toLocaleString()} points per field, ${(st.bytes / 1e6).toFixed(1)} MB)`,
  );
  console.log(
    "view   |  width (s) | buckets | cold ms | warm ms | pan 10%            | nodes cached",
  );
  // following views as the chart asks for them: span + 50% overscan before
  const views: [string, number][] = [
    ["1w", 7 * DAY],
    ["1m", YEAR / 12],
    ["6m", YEAR / 2],
    ["1y", YEAR],
    ["2y", 2 * YEAR],
    ["5y", 5 * YEAR],
  ];
  for (const [label, span] of views) {
    const fresh = longStore();
    const source = fresh.source("AAPL.OQ", "mid", now);
    const spec = {
      start: now - 1.5 * span,
      end: now,
      points: Math.ceil(width * 1.5),
    };
    const t0 = performance.now();
    const w = new BucketWindow(["mid"], () => source, 1000);
    const d = w.setWindow(spec, now);
    const cold = performance.now() - t0;
    const t1 = performance.now();
    new BucketWindow(["mid"], () => source, 1000).setWindow(spec, now);
    const warm = performance.now() - t1;
    const t2 = performance.now();
    const pan = w.setWindow(
      { ...spec, start: spec.start - span / 10, end: spec.end - span / 10 },
      now,
    );
    const panMs = performance.now() - t2;
    console.log(
      [
        label.padEnd(6),
        String(d.width / 1000).padStart(10),
        String(d.upserts.length).padStart(7),
        cold.toFixed(2).padStart(7),
        warm.toFixed(2).padStart(7),
        `+${pan.upserts.length} / −${pan.removed.length}, ${panMs.toFixed(2)} ms`.padEnd(
          18,
        ),
        String(fresh.stats().treeNodes).padStart(12),
      ].join(" | "),
    );
  }
  // drill down, one zoom step (÷4) at a time, into a point 3.7 years back
  const fresh = longStore();
  const source = fresh.source("AAPL.OQ", "mid", now);
  const target = now - 3.7 * YEAR;
  const w = new BucketWindow(["mid"], () => source, 1000);
  let span = 5 * YEAR;
  const steps: string[] = [];
  let total = 0;
  let maxMs = 0;
  let n = 0;
  while (span >= 60_000) {
    const t0 = performance.now();
    const d = w.setWindow(
      {
        start: target - span,
        end: target + span,
        points: width * 2,
      },
      now,
    );
    const ms = performance.now() - t0;
    total += ms;
    maxMs = Math.max(maxMs, ms);
    n++;
    if (n % 3 === 1)
      steps.push(
        `${(span / 1000).toFixed(0)}s span: ${d.width / 1000}s buckets ${ms.toFixed(2)} ms`,
      );
    span /= 4;
  }
  console.log(
    `drill-down to a minute 3.7 years back, ÷4 per step: ${n} steps, ${total.toFixed(1)} ms in all, worst ${maxMs.toFixed(2)} ms; nodes cached ${fresh.stats().treeNodes.toLocaleString()}`,
  );
  console.log(`  ${steps.join("\n  ")}`);
}
