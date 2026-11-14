import { describe, expect, test } from "bun:test";
import { type BucketValue, BucketWindow } from "../src/history/BucketWindow";
import { HistoryTree } from "../src/history/HistoryTree";
import { TimeSeriesStore } from "../src/history/TimeSeriesStore";
import { Random } from "../src/util/random";

const BASE = 1000;
const TOP = 17;
const TOP_W = BASE * 2 ** TOP;
const YEAR = 365 * 86_400_000;
const END = Math.floor(Date.UTC(2026, 10, 13) / TOP_W) * TOP_W;
const id = (x: number) => x;

const makeTree = (seed = 42, years = 5) => {
  const theta = 1 / (30 * 86_400_000);
  const diffusion = (0.09 * 10) / (365 * 86_400 * 1000);
  return new HistoryTree({
    baseMs: BASE,
    topLevel: TOP,
    start: END - years * YEAR,
    end: END,
    endValue: Math.log(182.5),
    params: {
      level: Math.log(182.5),
      components: [
        { theta, variance: diffusion / (2 * theta) },
        { theta: theta * 30, variance: 0.01 },
      ],
    },
    seed,
  });
};

/** M4 of consecutive buckets merged (as one wider bucket). */
const merge = (buckets: BucketValue[]) => {
  const out = { ...buckets[0] };
  for (const b of buckets.slice(1)) {
    out.count += b.count;
    if (b.min < out.min) {
      out.min = b.min;
      out.minT = b.minT;
    }
    if (b.max > out.max) {
      out.max = b.max;
      out.maxT = b.maxT;
    }
    out.last = b.last;
    out.lastT = b.lastT;
  }
  return out;
};

const m4Of = (bucket: BucketValue) => ({
  first: bucket.first,
  firstT: bucket.firstT,
  min: bucket.min,
  minT: bucket.minT,
  max: bucket.max,
  maxT: bucket.maxT,
  last: bucket.last,
  lastT: bucket.lastT,
  count: bucket.count,
});

describe("HistoryTree", () => {
  const tree = makeTree();

  test("covers the span, aligned to the top width", () => {
    expect(tree.end).toBe(END);
    expect(tree.start % TOP_W).toBe(0);
    expect(tree.length).toBeGreaterThan((5 * YEAR) / BASE);
  });

  test("children's M4 merge to exactly their parent's, at every level", () => {
    const rng = new Random(3);
    for (let k = 0; k < 2_000; k++) {
      const level = 1 + rng.int(0, TOP - 1);
      const w = BASE * 2 ** level;
      const s = tree.start + rng.int(0, (tree.end - tree.start) / w - 1) * w;
      const [parent] = tree.bucketsIn(s, s + w, w, id);
      const children = tree.bucketsIn(s, s + w, w / 2, id);
      expect(children).toHaveLength(2);
      expect(m4Of(merge(children))).toEqual(m4Of(parent));
    }
  });

  test("single points reproduce a bucket's M4", () => {
    const w = BASE * 2 ** 12;
    const s = tree.start + 4_321 * w;
    const [bucket] = tree.bucketsIn(s, s + w, w, id);
    const { times, values } = tree.points(s, s + w, id);
    expect(values).toHaveLength(4096);
    let lo = 0;
    let hi = 0;
    for (let i = 1; i < values.length; i++) {
      if (values[i] < values[lo]) lo = i;
      if (values[i] > values[hi]) hi = i;
    }
    expect(values[0]).toBe(bucket.first);
    expect(values[values.length - 1]).toBe(bucket.last);
    expect([times[lo], values[lo]]).toEqual([bucket.minT, bucket.min]);
    expect([times[hi], values[hi]]).toEqual([bucket.maxT, bucket.max]);
  });

  test("deterministic per seed, whatever order buckets are asked in", () => {
    const s = tree.start + 777 * TOP_W;
    const w = BASE * 16;
    const other = makeTree();
    // warm a different part of the other tree first
    other.bucketsIn(s + 50 * TOP_W, s + 51 * TOP_W, BASE * 64, id);
    expect(other.bucketsIn(s, s + 2_000 * w, w, id)).toEqual(
      tree.bucketsIn(s, s + 2_000 * w, w, id),
    );
    expect(makeTree(43).bucketsIn(s, s + 10 * w, w, id)).not.toEqual(
      tree.bucketsIn(s, s + 10 * w, w, id),
    );
  });

  test("a bucket wider than the top level merges top buckets", () => {
    const w = TOP_W * 8;
    const from = Math.ceil(tree.start / w) * w;
    const [wide] = tree.bucketsIn(from, from + w, w, id);
    expect(m4Of(wide)).toEqual(
      m4Of(merge(tree.bucketsIn(from, from + w, TOP_W, id))),
    );
  });

  test("an evicting cache regenerates identical buckets", () => {
    const small = new HistoryTree({
      baseMs: BASE,
      topLevel: TOP,
      start: END - YEAR,
      end: END,
      endValue: Math.log(100),
      params: {
        level: Math.log(100),
        components: [{ theta: 1e-9, variance: 0.04 }],
      },
      seed: 9,
      cacheLimit: 200,
    });
    const s = small.start + 100 * TOP_W;
    const first = small.bucketsIn(s, s + 500_000, BASE * 4, id);
    small.bucketsIn(s + 30 * TOP_W, s + 31 * TOP_W, BASE * 256, id);
    expect(small.cacheSize).toBeLessThanOrEqual(200);
    expect(small.bucketsIn(s, s + 500_000, BASE * 4, id)).toEqual(first);
  });
});

describe("TimeSeriesStore with a long history", () => {
  const now = END + 5_000_123;
  const store = new TimeSeriesStore({
    intervalMs: BASE,
    historyMs: 5 * YEAR,
    maxHistoryRics: 2,
    timeScale: 10,
    seed: 1,
    source: () => ({
      mid: 182.5,
      volatility: 0.3,
      tick: 0.01,
      decimals: 2,
      spreadBps: 3,
    }),
  });
  const source = store.source("AAA", "mid", now);

  test("a tree for five years, a stored tail to now", () => {
    const tree = source.tree as HistoryTree;
    expect(tree).toBeDefined();
    expect(store.treeTopWidth).toBe(TOP_W);
    expect(tree.end).toBe(END);
    expect(source.first).toBeLessThanOrEqual(now - 5 * YEAR);
    expect(source.stored.first).toBe(END);
    expect(source.stored.length).toBe(
      (Math.floor(now / BASE) * BASE - END) / BASE,
    );
    // memory is the tail and the cache, not five years of points
    expect(store.stats().bytes).toBeLessThan(5_000_000);
  });

  test("the tree joins the stored tail without a jump", () => {
    const tree = source.tree as HistoryTree;
    const { values } = tree.points(END - BASE, END, Math.exp);
    const step = Math.abs(Math.log(source.stored.values[0] / values[0]));
    expect(step).toBeLessThan(0.002);
  });

  test("buckets of 2w are pairs of buckets of w, across the seam", () => {
    for (const w of [BASE * 2 ** 10, TOP_W, TOP_W * 4]) {
      const from = Math.floor((END - 6 * TOP_W) / (2 * w)) * 2 * w;
      const to = Math.ceil((now + 1) / (2 * w)) * 2 * w;
      const narrow = source.bucketsIn(from, to, w);
      const wide = source.bucketsIn(from, to, 2 * w);
      for (const bucket of wide) {
        const pair = narrow.filter(
          (b) => b.bucket >= bucket.bucket && b.bucket < bucket.bucket + 2 * w,
        );
        expect(m4Of(merge(pair))).toEqual(m4Of(bucket));
      }
    }
  });

  test("a subscription pans across five years in steps", () => {
    const w = new BucketWindow(["mid"], () => source, BASE);
    const span = 30 * 86_400_000;
    const first = w.setWindow(
      { start: now - span, end: now, points: 1200 },
      now,
    );
    expect(first.upserts.length).toBeGreaterThan(600);
    const pan = w.setWindow(
      { start: now - 1.1 * span, end: now - 0.1 * span, points: 1200 },
      now,
    );
    expect(pan.reset).toBe(false);
    expect(pan.upserts.length).toBeLessThan(first.upserts.length / 5);
    const old = w.setWindow(
      { start: now - 4 * YEAR, end: now - 4 * YEAR + 60_000, points: 1200 },
      now,
    );
    // a minute four years ago, at single points
    expect(old.width).toBe(BASE);
    expect(old.upserts.length).toBeGreaterThanOrEqual(60);
  });
});
