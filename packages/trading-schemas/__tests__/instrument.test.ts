import { describe, expect, test } from "bun:test";
import { contractMultiplierOf, usdPerUnit } from "../src";

describe("contract multiplier", () => {
  test("defaults to 1 when absent or invalid", () => {
    expect(contractMultiplierOf(undefined)).toBe(1);
    expect(contractMultiplierOf({})).toBe(1);
    expect(contractMultiplierOf({ contractMultiplier: 0 })).toBe(1);
    expect(contractMultiplierOf({ contractMultiplier: -5 })).toBe(1);
    expect(contractMultiplierOf({ contractMultiplier: 10 })).toBe(10);
  });

  test("usdPerUnit is the currency conversion times the multiplier", () => {
    expect(usdPerUnit({ usdPerPriceUnit: 0.0127 })).toBe(0.0127);
    expect(
      usdPerUnit({ usdPerPriceUnit: 1.08, contractMultiplier: 10 }),
    ).toBeCloseTo(10.8);
  });
});
