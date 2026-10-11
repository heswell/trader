import { describe, expect, test } from "bun:test";
import {
  decimalsOf,
  formatTickBands,
  isOnTick,
  isValidLot,
  parseTickBands,
  roundToLot,
  roundToTick,
  stepTicks,
  tickScheduleOf,
  tickSizeAt,
  ticksBetween,
} from "../src";

const bands = parseTickBands("0:0.001;1:0.005;10:0.01") ?? [];

describe("ticks", () => {
  test("decimalsOf", () => {
    expect(decimalsOf(0.01)).toBe(2);
    expect(decimalsOf(0.0005)).toBe(4);
    expect(decimalsOf(1)).toBe(0);
    expect(decimalsOf(0.25)).toBe(2);
  });

  test("flat tick: isOnTick handles float noise", () => {
    expect(isOnTick(100.01, 0.01)).toBe(true);
    expect(isOnTick(0.1 + 0.2, 0.1)).toBe(true);
    expect(isOnTick(100.015, 0.01)).toBe(false);
    expect(isOnTick(100, 0)).toBe(false);
  });

  test("roundToTick modes", () => {
    expect(roundToTick(100.014, 0.01)).toBe(100.01);
    expect(roundToTick(100.011, 0.01, "up")).toBe(100.02);
    expect(roundToTick(100.019, 0.01, "down")).toBe(100.01);
    expect(roundToTick(100.02, 0.01, "up")).toBe(100.02);
    expect(roundToTick(1.2345, 0.0005)).toBe(1.2345);
  });

  test("banded schedule", () => {
    expect(tickSizeAt(bands, 0.5)).toBe(0.001);
    expect(tickSizeAt(bands, 1)).toBe(0.005);
    expect(tickSizeAt(bands, 50)).toBe(0.01);
    expect(isOnTick(1.003, bands)).toBe(false);
    expect(isOnTick(0.999, bands)).toBe(true);
  });

  test("stepTicks crosses band boundaries", () => {
    expect(stepTicks(0.999, bands, 1)).toBe(1);
    expect(stepTicks(1, bands, 1)).toBe(1.005);
    expect(stepTicks(1, bands, -1)).toBe(0.999);
    expect(stepTicks(10, bands, -1)).toBe(9.995);
    expect(stepTicks(10, bands, 2)).toBe(10.02);
    expect(stepTicks(100.013, 0.01, 1)).toBe(100.02);
    expect(stepTicks(100.013, 0.01, -2)).toBe(100);
    expect(stepTicks(100.01, 0.01, 0)).toBe(100.01);
  });

  test("ticksBetween", () => {
    expect(ticksBetween(100, 100.1, 0.01)).toBe(10);
    expect(ticksBetween(0.998, 1.01, bands)).toBe(4);
    expect(ticksBetween(1.01, 0.998, bands)).toBe(-4);
  });

  test("lots", () => {
    expect(isValidLot(300, 100)).toBe(true);
    expect(isValidLot(250, 100)).toBe(false);
    expect(isValidLot(0, 100)).toBe(false);
    expect(isValidLot(1.5, 0.5)).toBe(true);
    expect(roundToLot(250, 100, "down")).toBe(200);
    expect(roundToLot(201, 100, "up")).toBe(300);
    expect(roundToLot(260, 100)).toBe(300);
  });

  test("tick band parse/format", () => {
    expect(parseTickBands("")).toBeUndefined();
    expect(formatTickBands(bands)).toBe("0:0.001;1:0.005;10:0.01");
    expect(() => parseTickBands("1:0.01;0:0.001")).toThrow();
    expect(() => parseTickBands("x")).toThrow();
    expect(tickScheduleOf({ tickSize: 0.01, tickBands: "" })).toBe(0.01);
    expect(tickScheduleOf({ tickSize: 0.01, tickBands: "0:0.5" })).toEqual([
      { from: 0, tickSize: 0.5 },
    ]);
  });
});
