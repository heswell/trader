import { describe, expect, test } from "bun:test";
import { createExchangeTableDefs } from "@heswell/trading-schemas/server";
import {
  bucketsIn,
  bucketWidthFor,
  BucketWindow,
} from "../src/history/BucketWindow";
import { lowerBound, scanMinMax } from "../src/history/downsample";
import { TimeSeries } from "../src/history/TimeSeries";
import { TimeSeriesStore } from "../src/history/TimeSeriesStore";
import { TimeSeriesBucketPublisher } from "../src/publish/TimeSeriesBucketPublisher";
import { Random } from "../src/util/random";
import { FakeTable } from "./fakeTables";

const T0 = 1_763_000_000_000;
const series = (n: number, seed = 1) => {
  const rng = new Random(seed);
  const s = new TimeSeries(3_000, n + 16);
  let v = 100;
  for (let i = 0; i < n; i++) {
    v += rng.normal() * 0.1;
    s.append(T0 + i * 1000, v);
  }
  return s;
};

describe("bucketWidthFor", () => {
  test("largest base × 2^k not wider than span / points", () => {
    expect(bucketWidthFor(3_600_000, 1_000, 1000)).toBe(2_000);
    expect(bucketWidthFor(86_400_000, 1_000, 1000)).toBe(64_000);
    expect(bucketWidthFor(60_000, 1_000, 1000)).toBe(1_000);
  });
});

describe("bucketsIn", () => {
  test("first / min / max / last of each aligned bucket", () => {
    const s = series(10_000);
    const width = 64_000;
    const from = Math.floor(T0 / width) * width;
    const rows = bucketsIn(s, from, from + 20 * width, width);
    expect(rows.length).toBe(20);
    const out: [number, number] = [0, 0];
    for (const r of rows) {
      expect(r.bucket % width).toBe(0);
      const lo = lowerBound(s.times, r.bucket, 0, s.length);
      const hi = lowerBound(s.times, r.bucket + width, 0, s.length);
      scanMinMax(s.values, lo, hi, out);
      expect([r.count, r.firstT, r.lastT, r.min, r.max]).toEqual([
        hi - lo,
        s.times[lo],
        s.times[hi - 1],
        s.values[out[0]],
        s.values[out[1]],
      ]);
    }
  });
});

describe("BucketWindow", () => {
  const make = (s: TimeSeries) => new BucketWindow(["mid"], () => s, 1000);
  const now = T0 + 10_000 * 1000;

  test("a pan sends only the buckets entering and leaving", () => {
    const w = make(series(10_000));
    const span = 2_000_000;
    const first = w.setWindow(
      { start: T0 + 1_000_000, end: T0 + 1_000_000 + span, points: 500 },
      now,
    );
    expect(first.width).toBe(4_000);
    expect(first.upserts.length).toBe(500);
    expect(first.removed.length).toBe(0);
    const pan = w.setWindow(
      { start: T0 + 1_200_000, end: T0 + 1_200_000 + span, points: 500 },
      now,
    );
    expect(pan.reset).toBe(false);
    expect(pan.upserts.length).toBe(50);
    expect(pan.removed.length).toBe(50);
    expect(w.size).toBe(500);
  });

  test("a zoom inside the width level adds / removes; a new level resends all", () => {
    const w = make(series(10_000));
    w.setWindow(
      { start: T0 + 1_000_000, end: T0 + 3_000_000, points: 500 },
      now,
    );
    const inside = w.setWindow(
      { start: T0 + 1_000_000, end: T0 + 3_500_000, points: 500 },
      now,
    );
    expect(inside.width).toBe(4_000);
    expect(inside.reset).toBe(false);
    expect(inside.removed.length).toBe(0);
    expect(inside.upserts.length).toBe(125);
    const level = w.setWindow(
      { start: T0 + 1_000_000, end: T0 + 5_000_000, points: 500 },
      now,
    );
    expect(level.width).toBe(8_000);
    expect(level.reset).toBe(true);
    expect(level.removed.length).toBe(625);
    expect(level.upserts.length).toBe(500);
  });

  test("a tick updates only its own bucket; follow slides the window", () => {
    const s = series(10_000);
    const w = make(s);
    let t = T0 + 10_000 * 1000;
    w.setWindow({ start: t - 600_000, end: t, points: 100, follow: true }, t);
    expect(w.width).toBe(4_000);
    // a point in the open (last) bucket: one update, no slide
    s.append(t, 101);
    const tick = w.tick(t + 1);
    expect(tick.removed).toEqual([]);
    expect(tick.upserts.map((u) => u.value.bucket)).toEqual([t - (t % 4_000)]);
    // 4 more seconds: the window slides by one bucket
    for (let i = 1; i <= 4; i++) s.append(t + i * 1000, 101 + i);
    t += 4_001;
    const slide = w.tick(t);
    expect(slide.removed.length).toBe(1);
    expect(slide.upserts.length).toBeGreaterThanOrEqual(1);
    expect(slide.upserts.length).toBeLessThanOrEqual(2);
    // a tick with no new point and no slide sends nothing
    const idle = w.tick(t);
    expect(idle.upserts.length + idle.removed.length).toBe(0);
  });
});

describe("TimeSeriesBucketPublisher", () => {
  const defs = createExchangeTableDefs();
  const now = Math.floor(T0 / 1000) * 1000;
  const setup = () => {
    const store = new TimeSeriesStore({
      intervalMs: 1000,
      historyMs: 6 * 3_600_000,
      maxHistoryRics: 2,
      timeScale: 10,
      seed: 1,
      source: () => ({
        mid: 100,
        volatility: 0.3,
        tick: 0.01,
        decimals: 2,
        spreadBps: 4,
      }),
    });
    const table = new FakeTable(defs.timeSeriesBuckets.columns, "id");
    return {
      store,
      table,
      pub: new TimeSeriesBucketPublisher(table, store, 10_000),
    };
  };

  test("rows per bucket, moved and closed like a viewport", () => {
    const { table, pub } = setup();
    const res = pub.setWindow(
      {
        subId: "s1",
        ric: "AAA",
        fields: "mid,spreadBps",
        start: now - 3_600_000,
        end: now,
        points: 900,
      },
      now,
      "alice",
    );
    expect(res.bucketMs).toBe(4_000);
    expect(table.rowCount).toBe(res.buckets);
    expect(res.buckets).toBe(1_800);
    const row = table.get(`s1|mid|${now - 4_000}`);
    expect(row).toMatchObject({
      subId: "s1",
      ric: "AAA",
      field: "mid",
      width: 4_000,
      count: 4,
    });
    expect(() =>
      pub.setWindow(
        { subId: "s1", ric: "AAA", start: 0, end: 1, points: 1 },
        now,
        "bob",
      ),
    ).toThrow(/another user/);
    pub.close("s1", "alice");
    expect(table.rowCount).toBe(0);
  });

  test("ticks stream into the last bucket; an idle subscription expires", () => {
    const { store, table, pub } = setup();
    store.sample(now, [{ ric: "AAA", bid: 99.9, ask: 100.1 }]);
    pub.setWindow(
      {
        subId: "s1",
        ric: "AAA",
        start: now - 600_000,
        end: now + 1000,
        points: 150,
        follow: true,
      },
      now + 1,
    );
    table.resetCounts();
    store.sample(now + 1000, [{ ric: "AAA", bid: 100, ask: 100.2 }]);
    pub.tick(now + 1001);
    expect(table.updates + table.inserts).toBe(1);
    pub.tick(now + 20_000);
    expect(pub.subscriptionCount).toBe(0);
    expect(table.rowCount).toBe(0);
  });
});
