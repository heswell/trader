import { describe, expect, test } from "bun:test";
import {
  Histogram,
  MetricsCollector,
  type MetricSource,
  type MetricsSnapshot,
  ProcessSampler,
} from "../src";

const byId = (snapshot: MetricsSnapshot, id: string) =>
  snapshot.metrics.find((m) => m.id === id);

describe("MetricsCollector", () => {
  test("counter rates from totals between snapshots", () => {
    let total = 0;
    const collector = new MetricsCollector({ process: false });
    collector.register({
      name: "test",
      collect: (w) => w.counter("engine", "orders", total, "orders"),
    });
    const first = collector.sample(1_000);
    expect(first.intervalMs).toBe(0);
    expect(byId(first, "engine.orders")).toMatchObject({
      kind: "counter",
      unit: "orders",
      value: 0,
      rate: 0,
    });
    total = 500;
    const second = collector.sample(1_500);
    expect(second.intervalMs).toBe(500);
    expect(byId(second, "engine.orders")).toMatchObject({
      value: 500,
      rate: 1_000,
    });
    // a total that goes backwards (restore) gives rate 0, not negative
    total = 100;
    expect(byId(collector.sample(2_500), "engine.orders")?.rate).toBe(0);
  });

  test("gauges and timers; a timer's histogram is reset", () => {
    const h = new Histogram();
    const collector = new MetricsCollector({ process: false });
    collector.register({
      name: "test",
      collect: (w) => {
        w.gauge("oms", "liveOrders", 42);
        w.timer("engine", "match", h);
      },
    });
    collector.sample(0);
    for (const v of [10, 20, 30, 40]) h.record(v);
    const snapshot = collector.sample(2_000);
    expect(byId(snapshot, "oms.liveOrders")).toMatchObject({
      kind: "gauge",
      value: 42,
      rate: 0,
    });
    expect(byId(snapshot, "engine.match")).toMatchObject({
      kind: "timer",
      unit: "us",
      value: 4,
      rate: 2,
      mean: 25,
      max: 40,
    });
    expect(h.count).toBe(0);
  });

  test("table rows and writes merge into one row per table", () => {
    let writes = 0;
    const collector = new MetricsCollector({ process: false });
    collector.register({
      name: "rows",
      collect: (w) => {
        w.tableRows("EXCHANGE", "prices", 200);
        w.tableRows("EXCHANGE", "simBooks", 3);
      },
    });
    collector.register({
      name: "writes",
      collect: (w) => w.tableWrites("EXCHANGE", "prices", writes),
    });
    collector.sample(0);
    writes = 300;
    const { tables } = collector.sample(1_000);
    expect(tables).toEqual([
      {
        id: "EXCHANGE.prices",
        module: "EXCHANGE",
        table: "prices",
        rows: 200,
        counted: true,
        writes: 300,
        writesPerSec: 300,
      },
      {
        id: "EXCHANGE.simBooks",
        module: "EXCHANGE",
        table: "simBooks",
        rows: 3,
        counted: false,
        writes: 0,
        writesPerSec: 0,
      },
    ]);
  });

  test("a failing source is logged once and does not stop the others", () => {
    const log: string[] = [];
    const collector = new MetricsCollector({
      process: false,
      log: (m) => log.push(m),
    });
    const bad: MetricSource = {
      name: "bad",
      collect: () => {
        throw Error("boom");
      },
    };
    collector.register(bad);
    collector.register({ name: "ok", collect: (w) => w.gauge("a", "b", 1) });
    collector.sample(0);
    const snapshot = collector.sample(1);
    expect(byId(snapshot, "a.b")?.value).toBe(1);
    expect(log).toEqual(["metrics source bad failed: Error: boom"]);
  });

  test("unregister and listeners", () => {
    const collector = new MetricsCollector({ process: false });
    const off = collector.register({
      name: "x",
      collect: (w) => w.gauge("a", "b", 1),
    });
    const seen: MetricsSnapshot[] = [];
    const unlisten = collector.onSnapshot((s) => seen.push(s));
    collector.sample(0);
    off();
    collector.sample(1);
    unlisten();
    collector.sample(2);
    expect(seen.map((s) => s.metrics.length)).toEqual([1, 0]);
    expect(collector.latest?.time).toBe(2);
  });

  test("start / stop take snapshots on the timer, with process metrics", async () => {
    const collector = new MetricsCollector({
      intervalMs: 20,
      process: new ProcessSampler({ lagTickMs: 5 }),
    });
    const seen: MetricsSnapshot[] = [];
    collector.onSnapshot((s) => seen.push(s));
    collector.start();
    expect(collector.running).toBe(true);
    await Bun.sleep(120);
    collector.stop();
    expect(collector.running).toBe(false);
    const count = seen.length;
    expect(count).toBeGreaterThanOrEqual(3);
    const p = seen.at(-1)?.process;
    expect(p?.pid).toBe(process.pid);
    expect(p?.rssBytes).toBeGreaterThan(0);
    expect(p?.cpuPct).toBeGreaterThanOrEqual(0);
    expect(p?.loopLagMaxMs).toBeGreaterThanOrEqual(0);
    await Bun.sleep(50);
    expect(seen.length).toBe(count);
  });

  test("intervalMs must be positive", () => {
    expect(() => new MetricsCollector({ intervalMs: 0 })).toThrow();
  });
});
