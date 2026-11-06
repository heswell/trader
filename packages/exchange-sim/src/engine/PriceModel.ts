import { roundToTick, type TickSchedule } from "@heswell/trading-schemas";
import type { Random } from "../util/random";

/** Trading seconds per year used to convert elapsed time to GBM dt. */
export const SECONDS_PER_YEAR = 252 * 8.5 * 3600;

/** Impact is quoted per this much traded notional (USD). */
export const IMPACT_NOTIONAL_USD = 100_000;
/** ...at this volatility; impact scales with volatility / this. */
export const IMPACT_REFERENCE_VOL = 0.3;

export interface ImpactParams {
  /**
   * Log-price move per IMPACT_NOTIONAL_USD of aggressive notional at
   * IMPACT_REFERENCE_VOL (e.g. 0.0008 = 8 bps). 0 = no impact.
   */
  k: number;
  /** Share of each move that is permanent (goes into the walk). */
  permanentShare: number;
  /** Half-life of the transient part, wall-clock seconds. */
  halfLifeSec: number;
}

export const NO_IMPACT: Readonly<ImpactParams> = Object.freeze({
  k: 0,
  permanentShare: 0.3,
  halfLifeSec: 30,
});

/** Saved impact state (alongside the fair value). */
export interface PriceModelState {
  /** Transient log offset of fair over the walk. */
  transient: number;
  /** Permanent log move from flow since the band was last recentred. */
  impactToday: number;
  /** The price the band is centred on. */
  bandCentre: number;
}

/**
 * Fair-value process for one instrument: `fair = walk × exp(transient)`.
 * The walk is a zero-drift geometric Brownian motion reflected inside a band
 * of ±bandPct; aggressive trades move it (permanent impact) and add a
 * transient offset that fades with a half-life. `volatility` is the total
 * the model aims for: with impact, the walk's own volatility is scaled down
 * by `walkVolShare` so flow makes up the rest.
 */
export class PriceModel {
  #lowerBand = 0;
  #upperBand = 0;
  #bandCentre: number;
  #walk: number;
  #transient = 0;
  #impactToday = 0;
  /** Share of the variance the walk supplies itself (1 without impact). */
  walkVolShare = 1;
  impact: ImpactParams = { ...NO_IMPACT };

  constructor(
    readonly refPrice: number,
    readonly schedule: TickSchedule,
    public volatility: number,
    readonly bandPct: number,
  ) {
    this.#walk = refPrice;
    this.#bandCentre = refPrice;
    this.#setBand(refPrice);
  }

  #setBand(centre: number) {
    this.#bandCentre = centre;
    this.#lowerBand = roundToTick(
      centre * (1 - this.bandPct),
      this.schedule,
      "up",
    );
    this.#upperBand = roundToTick(
      centre * (1 + this.bandPct),
      this.schedule,
      "down",
    );
  }

  get lowerBand() {
    return this.#lowerBand;
  }

  get upperBand() {
    return this.#upperBand;
  }

  get bandCentre() {
    return this.#bandCentre;
  }

  get fairValue() {
    return this.clampToBand(this.#walk * Math.exp(this.#transient));
  }

  /** Restore a persisted fair value (clamped to the band); keeps the transient. */
  set fairValue(value: number) {
    if (Number.isFinite(value) && value > 0)
      this.#walk = this.clampToBand(value / Math.exp(this.#transient));
  }

  /** The walk: fair value without the transient impact. */
  get walk() {
    return this.#walk;
  }

  /** Transient impact, bps of the walk. */
  get impactOffsetBps() {
    return (Math.exp(this.#transient) - 1) * 1e4;
  }

  /** Permanent move from flow since the band was last recentred, bps. */
  get impactTodayBps() {
    return (Math.exp(this.#impactToday) - 1) * 1e4;
  }

  /** Fair value snapped to the tick grid. */
  get fairOnTick() {
    return roundToTick(this.fairValue, this.schedule);
  }

  isWithinBand(price: number) {
    return price >= this.#lowerBand && price <= this.#upperBand;
  }

  clampToBand(price: number) {
    return Math.min(this.#upperBand, Math.max(this.#lowerBand, price));
  }

  /**
   * Recentre the band on the current fair value (at each session close, so
   * trends and impact don't pile up against a fixed wall) and start a new
   * day's impact total.
   */
  recentre() {
    this.#walk = this.fairValue;
    this.#transient = 0;
    this.#impactToday = 0;
    this.#setBand(this.#walk);
  }

  /**
   * Move fair value for an aggressive trade: `sign` +1 buy / -1 sell,
   * `notionalUsd` the traded notional.
   */
  applyImpact(sign: number, notionalUsd: number) {
    const { k, permanentShare } = this.impact;
    if (k <= 0 || !(notionalUsd > 0)) return;
    const move =
      sign *
      k *
      (notionalUsd / IMPACT_NOTIONAL_USD) *
      (this.volatility / IMPACT_REFERENCE_VOL);
    const permanent = move * permanentShare;
    const before = this.#walk;
    this.#walk = this.clampToBand(before * Math.exp(permanent));
    this.#impactToday += Math.log(this.#walk / before);
    this.#transient += move - permanent;
  }

  exportState(): PriceModelState {
    return {
      transient: this.#transient,
      impactToday: this.#impactToday,
      bandCentre: this.#bandCentre,
    };
  }

  restoreState(state: Partial<PriceModelState>) {
    if (Number.isFinite(state.bandCentre) && (state.bandCentre as number) > 0)
      this.#setBand(state.bandCentre as number);
    if (Number.isFinite(state.transient))
      this.#transient = state.transient as number;
    if (Number.isFinite(state.impactToday))
      this.#impactToday = state.impactToday as number;
    this.#walk = this.clampToBand(this.#walk);
  }

  /**
   * Advance by `dtSeconds` of simulated time; the transient fades over
   * `wallDtSeconds` of clock time (default: the same).
   */
  step(dtSeconds: number, rng: Random, wallDtSeconds = dtSeconds) {
    if (this.#transient !== 0 && wallDtSeconds > 0) {
      const halfLife = this.impact.halfLifeSec;
      this.#transient =
        halfLife > 0 ? this.#transient * 0.5 ** (wallDtSeconds / halfLife) : 0;
    }
    if (dtSeconds <= 0 || this.volatility <= 0) return this.fairValue;
    const dt = dtSeconds / SECONDS_PER_YEAR;
    const sigma = this.volatility * Math.sqrt(this.walkVolShare);
    let next =
      this.#walk *
      Math.exp(
        -0.5 * sigma * sigma * dt + sigma * Math.sqrt(dt) * rng.normal(),
      );
    const lo = this.#lowerBand;
    const hi = this.#upperBand;
    if (next > hi) next = Math.max(lo, hi - (next - hi));
    else if (next < lo) next = Math.min(hi, lo + (lo - next));
    this.#walk = next;
    return this.fairValue;
  }
}
