import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import {
  Sparkline,
  SparklineBuffer,
  SparklineStore,
  recordSample,
  sparklinePoints,
} from "../src";

describe("SparklineBuffer", () => {
  test("keeps the newest `capacity` samples", () => {
    const b = new SparklineBuffer(3);
    for (const v of [1, 2, 3, 4, 5]) b.push(v);
    expect(b.toArray()).toEqual([3, 4, 5]);
    expect(b.last).toBe(5);
  });

  test("recordSample skips repeats and buckets by time", () => {
    const b = new SparklineBuffer(10);
    expect(recordSample(b, 1)).toBe(true);
    expect(recordSample(b, 1)).toBe(false);
    expect(recordSample(b, Number.NaN)).toBe(false);
    const t = new SparklineBuffer(10);
    let now = 0;
    const opts = { bucketMs: 1000, now: () => now };
    recordSample(t, 1, opts);
    now = 500;
    recordSample(t, 2, opts);
    now = 1500;
    recordSample(t, 3, opts);
    expect(t.toArray()).toEqual([2, 3]);
  });

  test("points: flat series mid-height, partial buffers grow from the right", () => {
    const b = new SparklineBuffer(5);
    b.push(1);
    expect(sparklinePoints(b, 40, 10)).toBe("");
    b.push(1);
    expect(sparklinePoints(b, 40, 10)).toBe("30.0,5.0 40.0,5.0");
  });
});

describe("SparklineStore", () => {
  test("memory is released when the last cell for a row goes", () => {
    const store = new SparklineStore();
    const a = store.acquire("r1", 40);
    const a2 = store.acquire("r1", 40);
    expect(a2).toBe(a);
    expect(store.size).toBe(1);
    expect(store.bytes).toBe(320);
    store.release("r1", a);
    expect(store.size).toBe(1);
    store.release("r1", a2);
    expect(store.size).toBe(0);
    expect(store.bytes).toBe(0);
  });
});

describe("Sparkline", () => {
  test("renders an accessible svg", () => {
    const { container } = render(<Sparkline values={[1, 2, 3]} />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("data-trend")).toBe("up");
    expect(svg?.getAttribute("aria-label")).toBeTruthy();
  });
});
