import { PutCall } from "./enums";

/**
 * Black-76 option pricing: European options on a forward. Shared by the
 * exchange simulator (fair values), the OMS (risk) and the UI (Greeks).
 *
 * Inputs are the forward (spot carried to expiry), the strike, the years to
 * expiry and an annualised volatility. `discount` is the discount factor to
 * expiry (1 = undiscounted, the simulator's default). Greeks are with
 * respect to the forward; multiply delta and gamma by dF/dS for spot Greeks.
 */
export interface OptionInputs {
  putCall: PutCall;
  forward: number;
  strike: number;
  /** Years to expiry; <= 0 prices at intrinsic value. */
  years: number;
  /** Annualised volatility, e.g. 0.25; <= 0 prices at intrinsic value. */
  vol: number;
  /** Discount factor to expiry (default 1). */
  discount?: number;
}

export interface OptionGreeks {
  price: number;
  /** dPrice / dForward. */
  delta: number;
  /** d²Price / dForward². */
  gamma: number;
  /** dPrice / dVol, per 1.00 of vol (divide by 100 for a vol point). */
  vega: number;
  /** dPrice / dTime, per year (negative as time passes). */
  theta: number;
}

const SQRT_2PI = Math.sqrt(2 * Math.PI);

/** Standard normal density. */
export const normPdf = (x: number) => Math.exp(-0.5 * x * x) / SQRT_2PI;

/**
 * Standard normal cumulative distribution (Numerical Recipes erfc
 * approximation; absolute error below 1.2e-7).
 */
export const normCdf = (x: number) => {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.5 * z);
  const erfc =
    t *
    Math.exp(
      -z * z -
        1.26551223 +
        t *
          (1.00002368 +
            t *
              (0.37409196 +
                t *
                  (0.09678418 +
                    t *
                      (-0.18628806 +
                        t *
                          (0.27886807 +
                            t *
                              (-1.13520398 +
                                t *
                                  (1.48851587 +
                                    t * (-0.82215223 + t * 0.17087277)))))))),
    );
  return x >= 0 ? 1 - 0.5 * erfc : 0.5 * erfc;
};

/** Intrinsic value: max(0, S - K) for a call, max(0, K - S) for a put. */
export const intrinsicValue = (
  putCall: PutCall,
  spot: number,
  strike: number,
) => Math.max(0, putCall === PutCall.Call ? spot - strike : strike - spot);

/** Black-76 price and Greeks. */
export const black76 = ({
  putCall,
  forward,
  strike,
  years,
  vol,
  discount = 1,
}: OptionInputs): OptionGreeks => {
  const call = putCall === PutCall.Call;
  if (!(years > 0) || !(vol > 0) || !(forward > 0) || !(strike > 0)) {
    const itm = call ? forward > strike : strike > forward;
    return {
      price: discount * intrinsicValue(putCall, forward, strike),
      delta: itm ? (call ? discount : -discount) : 0,
      gamma: 0,
      vega: 0,
      theta: 0,
    };
  }
  const sqrtT = Math.sqrt(years);
  const volT = vol * sqrtT;
  const d1 = (Math.log(forward / strike) + 0.5 * volT * volT) / volT;
  const d2 = d1 - volT;
  const pdf = normPdf(d1);
  const price = call
    ? discount * (forward * normCdf(d1) - strike * normCdf(d2))
    : discount * (strike * normCdf(-d2) - forward * normCdf(-d1));
  const delta = call ? discount * normCdf(d1) : -discount * normCdf(-d1);
  const gamma = (discount * pdf) / (forward * volT);
  const vega = discount * forward * pdf * sqrtT;
  // undiscounted rate: theta is the time decay of the forward option
  const theta = -(discount * forward * pdf * vol) / (2 * sqrtT);
  return { price, delta, gamma, vega, theta };
};

/** Black-76 price only. */
export const black76Price = (inputs: OptionInputs) => black76(inputs).price;

const MIN_VOL = 1e-4;
const MAX_VOL = 5;

/**
 * Implied volatility of a Black-76 price: Newton from a Brenner-Subrahmanyam
 * start, falling back to bisection. Undefined when the price is outside the
 * no-arbitrage bounds or there is no time left.
 */
export const impliedVol = (
  price: number,
  inputs: Omit<OptionInputs, "vol">,
  tolerance = 1e-8,
): number | undefined => {
  const { putCall, forward, strike, years, discount = 1 } = inputs;
  if (!(years > 0) || !(forward > 0) || !(strike > 0)) return undefined;
  const lower = discount * intrinsicValue(putCall, forward, strike);
  const upper = discount * (putCall === PutCall.Call ? forward : strike);
  if (!(price > lower) || !(price < upper)) return undefined;
  const at = (vol: number) => black76({ ...inputs, vol });

  let vol = Math.min(
    MAX_VOL,
    Math.max(
      0.05,
      (Math.sqrt((2 * Math.PI) / years) * price) / (discount * forward),
    ),
  );
  for (let i = 0; i < 20; i++) {
    const { price: p, vega } = at(vol);
    const diff = p - price;
    if (Math.abs(diff) < tolerance) return vol;
    if (vega < 1e-12) break;
    const next = vol - diff / vega;
    if (!(next > MIN_VOL && next < MAX_VOL)) break;
    vol = next;
  }
  let lo = MIN_VOL;
  let hi = MAX_VOL;
  for (let i = 0; i < 200; i++) {
    const mid = 0.5 * (lo + hi);
    const diff = at(mid).price - price;
    if (Math.abs(diff) < tolerance) return mid;
    if (diff > 0) hi = mid;
    else lo = mid;
  }
  return 0.5 * (lo + hi);
};
