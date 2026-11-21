import { describe, expect, test } from "bun:test";
import {
  black76,
  black76Price,
  impliedVol,
  intrinsicValue,
  normCdf,
  type OptionInputs,
  PutCall,
} from "../src";

const base: OptionInputs = {
  putCall: PutCall.Call,
  forward: 100,
  strike: 100,
  years: 1,
  vol: 0.2,
};

describe("option math", () => {
  test("normal cdf", () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 7);
    expect(normCdf(1.96)).toBeCloseTo(0.9750021, 6);
    expect(normCdf(-1.96)).toBeCloseTo(0.0249979, 6);
  });

  test("at-the-money call: F (N(d1) - N(d2)) with d1 = 0.1", () => {
    expect(black76Price(base)).toBeCloseTo(7.96557, 4);
  });

  test("put-call parity: C - P = D (F - K)", () => {
    for (const strike of [80, 100, 125]) {
      for (const discount of [1, 0.97]) {
        const call = black76Price({ ...base, strike, discount });
        const put = black76Price({
          ...base,
          strike,
          discount,
          putCall: PutCall.Put,
        });
        expect(call - put).toBeCloseTo(discount * (100 - strike), 6);
      }
    }
  });

  test("Greeks match finite differences", () => {
    for (const putCall of [PutCall.Call, PutCall.Put]) {
      const inputs = { ...base, putCall, strike: 110 };
      const g = black76(inputs);
      const h = 1e-3;
      const at = (o: Partial<typeof inputs>) =>
        black76Price({ ...inputs, ...o });
      expect(g.delta).toBeCloseTo(
        (at({ forward: 100 + h }) - at({ forward: 100 - h })) / (2 * h),
        5,
      );
      expect(g.gamma).toBeCloseTo(
        (at({ forward: 100 + h }) - 2 * g.price + at({ forward: 100 - h })) /
          (h * h),
        3,
      );
      expect(g.vega).toBeCloseTo(
        (at({ vol: 0.2 + h }) - at({ vol: 0.2 - h })) / (2 * h),
        4,
      );
      // theta is dPrice/dt: time to expiry shrinks
      expect(g.theta).toBeCloseTo(
        (at({ years: 1 - h }) - at({ years: 1 + h })) / (2 * h),
        4,
      );
    }
  });

  test("no time or no vol prices at intrinsic value", () => {
    expect(black76Price({ ...base, strike: 90, years: 0 })).toBe(10);
    expect(
      black76Price({ ...base, putCall: PutCall.Put, strike: 90, vol: 0 }),
    ).toBe(0);
    expect(black76({ ...base, strike: 90, years: 0 }).delta).toBe(1);
    expect(intrinsicValue(PutCall.Put, 95, 100)).toBe(5);
  });

  test("implied vol recovers the input vol", () => {
    for (const putCall of [PutCall.Call, PutCall.Put]) {
      for (const [strike, vol, years] of [
        [100, 0.2, 1],
        [70, 0.45, 0.1],
        [140, 0.3, 0.5],
        [101, 0.9, 0.02],
      ]) {
        const inputs = { ...base, putCall, strike, years };
        const price = black76Price({ ...inputs, vol });
        expect(impliedVol(price, inputs)).toBeCloseTo(vol, 6);
      }
    }
  });

  test("implied vol is undefined outside the no-arbitrage bounds", () => {
    expect(impliedVol(9, { ...base, strike: 90 })).toBeUndefined();
    expect(impliedVol(100, base)).toBeUndefined();
    expect(impliedVol(5, { ...base, years: 0 })).toBeUndefined();
  });
});
