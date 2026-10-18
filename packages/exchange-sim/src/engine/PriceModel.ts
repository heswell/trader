import { roundToTick, type TickSchedule } from "@heswell/trading-schemas";
import type { Random } from "../util/random";

/** Trading seconds per year used to convert elapsed time to GBM dt. */
export const SECONDS_PER_YEAR = 252 * 8.5 * 3600;

/**
 * Fair-value process for one instrument: geometric Brownian motion with zero
 * drift, reflected inside a static band of ±bandPct around refPrice.
 */
export class PriceModel {
  readonly lowerBand: number;
  readonly upperBand: number;
  #fair: number;

  constructor(
    readonly refPrice: number,
    readonly schedule: TickSchedule,
    public volatility: number,
    bandPct: number,
  ) {
    this.#fair = refPrice;
    this.lowerBand = roundToTick(refPrice * (1 - bandPct), schedule, "up");
    this.upperBand = roundToTick(refPrice * (1 + bandPct), schedule, "down");
  }

  get fairValue() {
    return this.#fair;
  }

  /** Restore a persisted fair value (clamped to the band). */
  set fairValue(value: number) {
    if (Number.isFinite(value) && value > 0)
      this.#fair = this.clampToBand(value);
  }

  /** Fair value snapped to the tick grid. */
  get fairOnTick() {
    return roundToTick(this.#fair, this.schedule);
  }

  isWithinBand(price: number) {
    return price >= this.lowerBand && price <= this.upperBand;
  }

  clampToBand(price: number) {
    return Math.min(this.upperBand, Math.max(this.lowerBand, price));
  }

  /** Advance by `dtSeconds` of simulated time. */
  step(dtSeconds: number, rng: Random) {
    if (dtSeconds <= 0 || this.volatility <= 0) return this.#fair;
    const dt = dtSeconds / SECONDS_PER_YEAR;
    const sigma = this.volatility;
    let next =
      this.#fair *
      Math.exp(
        -0.5 * sigma * sigma * dt + sigma * Math.sqrt(dt) * rng.normal(),
      );
    const lo = this.lowerBand;
    const hi = this.upperBand;
    if (next > hi) next = Math.max(lo, hi - (next - hi));
    else if (next < lo) next = Math.min(hi, lo + (lo - next));
    this.#fair = next;
    return next;
  }
}
