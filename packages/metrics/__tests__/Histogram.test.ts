import { describe, expect, test } from "bun:test";
import { Histogram } from "../src";

const exact = (values: number[], q: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)];
};

describe("Histogram", () => {
  test("empty", () => {
    const h = new Histogram();
    expect(h.count).toBe(0);
    expect(h.mean).toBe(0);
    expect(h.percentile(0.99)).toBe(0);
  });

  test("count, sum, mean, min, max are exact", () => {
    const h = new Histogram();
    for (const v of [5, 10, 15, 2000]) h.record(v);
    expect(h.count).toBe(4);
    expect(h.sum).toBe(2030);
    expect(h.mean).toBe(507.5);
    expect(h.min).toBe(5);
    expect(h.max).toBe(2000);
  });

  test("percentiles are within half a bucket (~3%) of exact", () => {
    let seed = 1;
    const random = () => {
      seed = (seed * 48271) % 0x7fffffff;
      return seed / 0x7fffffff;
    };
    // log-normal-ish latencies from ~10 µs to ~100 ms
    const values = Array.from(
      { length: 20_000 },
      () => 10 * 10 ** (4 * random()),
    );
    const h = new Histogram();
    for (const v of values) h.record(v);
    for (const q of [0.5, 0.9, 0.99, 0.999]) {
      const want = exact(values, q);
      expect(Math.abs(h.percentile(q) - want) / want).toBeLessThan(0.035);
    }
  });

  test("a single value reads back exactly (clamped to min / max)", () => {
    const h = new Histogram();
    h.record(1234.5);
    expect(h.percentile(0.5)).toBe(1234.5);
    expect(h.percentile(0.99)).toBe(1234.5);
  });

  test("sub-1 and huge values", () => {
    const h = new Histogram();
    h.record(0);
    h.record(0.2);
    h.record(1e12);
    expect(h.percentile(0.1)).toBe(0.5);
    expect(h.percentile(1)).toBe(1e12);
    expect(h.max).toBe(1e12);
  });

  test("reset", () => {
    const h = new Histogram();
    h.record(100);
    h.reset();
    expect(h.count).toBe(0);
    expect(h.max).toBe(0);
    expect(h.percentile(0.5)).toBe(0);
    h.record(7);
    expect(h.percentile(0.5)).toBe(7);
  });
});
