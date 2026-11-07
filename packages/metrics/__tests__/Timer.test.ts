import { describe, expect, test } from "bun:test";
import { MetricsCollector, Timer, TimerRegistry } from "../src";

const time = (timer: Timer, n: number) => {
  for (let i = 0; i < n; i++) timer.stop(timer.start());
};

describe("Timer", () => {
  test("off counts calls and times nothing", () => {
    const timer = new Timer("off");
    time(timer, 100);
    timer.record(5);
    expect(timer.calls).toBe(101);
    expect(timer.histogram.count).toBe(0);
    expect(timer.start()).toBe(-1);
  });

  test("all times every call", () => {
    const timer = new Timer("all");
    time(timer, 10);
    expect(timer.calls).toBe(10);
    expect(timer.histogram.count).toBe(10);
  });

  test("sampled times one call in sampleEvery", () => {
    const timer = new Timer("sampled", 8);
    time(timer, 80);
    expect(timer.histogram.count).toBe(10);
    for (let i = 0; i < 16; i++) timer.record(100);
    expect(timer.histogram.count).toBe(12);
    expect(timer.histogram.max).toBe(100);
    expect(timer.mode).toBe("sampled");
  });

  test("records elapsed µs", async () => {
    const timer = new Timer("all");
    const t0 = timer.start();
    await Bun.sleep(5);
    timer.stop(t0);
    expect(timer.histogram.max).toBeGreaterThan(4_000);
  });

  test("sampleEvery must be a power of two", () => {
    expect(() => new Timer("sampled", 10)).toThrow("power of two");
    expect(() => new TimerRegistry("sampled", 0)).toThrow("power of two");
  });
});

describe("TimerRegistry", () => {
  test("setMode applies to existing and new timers", () => {
    const registry = new TimerRegistry();
    const a = registry.timer("exchange", "limit");
    expect(registry.timer("exchange", "limit")).toBe(a);
    expect(a.mode).toBe("off");
    registry.setMode("all");
    expect(a.mode).toBe("all");
    expect(registry.timer("exchange", "cancel").mode).toBe("all");
    registry.setMode("sampled", 4);
    expect(a.mode).toBe("sampled");
    expect(registry.sampleEvery).toBe(4);
  });

  test("the collector reports a timer's calls per second and resets it", () => {
    const registry = new TimerRegistry("sampled", 4);
    const timer = registry.timer("oms", "createOrder");
    const collector = new MetricsCollector({ process: false });
    collector.register({ name: "t", collect: (w) => w.timers(registry) });
    collector.sample(0);
    time(timer, 40);
    const snapshot = collector.sample(2_000);
    const row = snapshot.metrics.find((m) => m.id === "oms.createOrder");
    expect(row).toMatchObject({
      kind: "timer",
      unit: "us",
      value: 10,
      rate: 20,
    });
    expect(timer.histogram.count).toBe(0);
    expect(timer.calls).toBe(40);
  });
});
