import {
  black76,
  impliedVol,
  type OptionGreeks,
  type PutCall,
  roundToTick,
  type TickSchedule,
  tickSizeAt,
} from "@heswell/trading-schemas";
import { carriedPrice, yearsToExpiry } from "../reference/futures";
import type { InstrumentDef } from "../reference/instruments";

/** What a derivative prices off: a stock's fair value or an index level. */
export interface Spot {
  price(): number;
  /** Price to list a new contract from (on tick for a stock). */
  listPrice(): number;
  /** Annual volatility in model time (the underlying's PriceModel). */
  volatility: number;
}

/** Lowest vol the surface returns, however steep the wings. */
export const MIN_SURFACE_VOL = 0.01;

/** Vol surface shape; flat across expiries. */
export interface VolSurface {
  /** Vol points per unit of log-moneyness ln(K/F) (negative = put skew). */
  skew: number;
  /** Vol points per unit of log-moneyness squared. */
  smile: number;
}

/** Log-moneyness beyond which the surface is flat (no runaway smile). */
export const MAX_LOG_MONEYNESS = 1;

/**
 * Surface vol at `strike`: the at-the-money vol plus a linear skew and a
 * quadratic smile in log-moneyness (flat beyond ±MAX_LOG_MONEYNESS),
 * floored at MIN_SURFACE_VOL.
 */
export const surfaceVol = (
  atmVol: number,
  forward: number,
  strike: number,
  { skew, smile }: VolSurface,
) => {
  if (!(forward > 0 && strike > 0)) return Math.max(MIN_SURFACE_VOL, atmVol);
  const k = Math.max(
    -MAX_LOG_MONEYNESS,
    Math.min(MAX_LOG_MONEYNESS, Math.log(strike / forward)),
  );
  return Math.max(MIN_SURFACE_VOL, atmVol + (skew * k + smile * k * k) / 100);
};

export interface OptionPricerOptions {
  surface: VolSurface;
  /** Annual carry of the forward over spot. */
  carryRate: number;
  /**
   * Vol multiplier from model time to the clock: √timeScale, so options
   * price the moves the sim actually makes before expiry.
   */
  volScale: number;
  /** Narrowest quote, vol points wide. */
  minWidthVolPts: number;
}

/** An option's terms, as the pricer needs them. */
export type OptionTerms = Pick<InstrumentDef, "ric" | "expiry"> & {
  putCall: PutCall;
  strike: number;
};

/** Black-76 values of one option, with the inputs they came from. */
export interface OptionValue extends OptionGreeks {
  forward: number;
  /** Surface vol, as priced (clock time). */
  vol: number;
  years: number;
}

/** A theoretical two-sided quote; `bid` undefined when it would be <= 0. */
export interface OptionQuote {
  bid: number | undefined;
  ask: number;
}

/** Option terms from a listed def (undefined if it is not an option). */
export const optionTerms = (def: InstrumentDef): OptionTerms | undefined =>
  def.putCall !== undefined && def.strike !== undefined
    ? {
        ric: def.ric,
        expiry: def.expiry,
        putCall: def.putCall,
        strike: def.strike,
      }
    : undefined;

/**
 * Prices the options on one underlying: Black-76 on the underlying's spot
 * carried to expiry, at the surface vol around the underlying's own
 * volatility, scaled to clock time.
 */
export class OptionPricer {
  constructor(
    readonly underlying: string,
    readonly spot: Spot,
    readonly options: OptionPricerOptions,
  ) {}

  forward(expiry: number, now: number) {
    return carriedPrice(this.spot.price(), this.options.carryRate, expiry, now);
  }

  /** Surface vol at `strike` for `forward`, as priced (clock time). */
  vol(forward: number, strike: number) {
    const { surface, volScale } = this.options;
    return (
      surfaceVol(this.spot.volatility, forward, strike, surface) * volScale
    );
  }

  /** Value and Greeks now; `logVolShift` moves the vol by exp(shift). */
  value(terms: OptionTerms, now: number, logVolShift = 0): OptionValue {
    const expiry = terms.expiry ?? now;
    const forward = this.forward(expiry, now);
    const vol = this.vol(forward, terms.strike) * Math.exp(logVolShift);
    const years = yearsToExpiry(expiry, now);
    return {
      ...black76({
        putCall: terms.putCall,
        forward,
        strike: terms.strike,
        years,
        vol,
      }),
      forward,
      vol,
      years,
    };
  }

  /** Premium only (the book anchor's hot path). */
  price(terms: OptionTerms, now: number, logVolShift = 0) {
    return this.value(terms, now, logVolShift).price;
  }

  /**
   * Half the narrowest quote width in ticks of `schedule` at `price`:
   * minWidthVolPts of vega, at least `minTicks`.
   */
  halfWidthTicks(
    value: Pick<OptionValue, "vega" | "price">,
    schedule: TickSchedule,
    minTicks = 1,
  ) {
    const tick = tickSizeAt(schedule, value.price);
    const half = (this.options.minWidthVolPts * value.vega) / 100 / 2;
    return Math.max(minTicks, Math.ceil(half / tick - 1e-9));
  }

  /**
   * A quote-only strike's theoretical bid / ask: `halfWidthTicks` (at least
   * two ticks) each side of the model price, on tick: a worthless option
   * is offered at two ticks. A bid at or below zero is left out.
   */
  quote(value: OptionValue, schedule: TickSchedule): OptionQuote {
    const tick = tickSizeAt(schedule, value.price);
    const half = this.halfWidthTicks(value, schedule, 2) * tick;
    const bid = roundToTick(value.price - half, schedule, "down");
    const ask = roundToTick(value.price + half, schedule, "up");
    return { bid: bid > 0 ? bid : undefined, ask };
  }

  /** Vol implied by `mid` (undefined outside the no-arbitrage bounds). */
  impliedVol(terms: OptionTerms, value: OptionValue, mid: number) {
    return impliedVol(mid, {
      putCall: terms.putCall,
      forward: value.forward,
      strike: terms.strike,
      years: value.years,
    });
  }
}

/** Elasticity bounds of an option book's premium volatility. */
const MIN_ELASTICITY = 1;
const MAX_ELASTICITY = 20;

/**
 * An option's premium volatility from its underlying's: the elasticity
 * |delta| × F / premium times the underlying's volatility (bounded), the
 * percentage move of the premium per percent of the underlying.
 */
export const premiumVolatility = (
  value: Pick<OptionValue, "delta" | "forward" | "price">,
  underlyingVol: number,
) => {
  const elasticity =
    value.price > 0 ? (Math.abs(value.delta) * value.forward) / value.price : 1;
  return (
    underlyingVol *
    Math.min(MAX_ELASTICITY, Math.max(MIN_ELASTICITY, elasticity))
  );
};
