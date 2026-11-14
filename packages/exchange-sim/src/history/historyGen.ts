import { SECONDS_PER_YEAR } from "../engine/PriceModel";
import type { Random } from "../util/random";

export interface HistoryGenParams {
  /** Points to generate, one every `intervalMs`, the last at `end - intervalMs`. */
  count: number;
  intervalMs: number;
  /** Exclusive end (aligned to intervalMs): the first live point's time, or now. */
  end: number;
  /** Mid the history must end at (the first live mid, or fair value). */
  mid: number;
  /** Annualised volatility of the price model. */
  volatility: number;
  /** Simulated-time multiplier (`exchangeSim.timeScale`), as the live walk. */
  timeScale: number;
  /** Tick size at `mid`: mids are on the half-tick grid. */
  tick: number;
  /** Typical spread in bps (the spread series' long-run level). */
  spreadBps: number;
  rng: Random;
}

export interface GeneratedHistory {
  times: Float64Array;
  mid: Float64Array;
  spreadBps: Float64Array;
}

/** Mean jumps per point (about one every two hours at 1 s). */
const JUMP_RATE = 1 / 7_200;
/** Jump size, in units of one point's diffusion. */
const JUMP_SIGMAS = 25;
/** Spread: mean reversion per second and volatility of log spread. */
export const SPREAD_THETA = 1 / 120;
export const SPREAD_SIGMA = 0.08;
/** Spread blowouts (a pulled quote), per point, and their size (× level). */
const SPREAD_SPIKE_RATE = 1 / 3_600;
const SPREAD_SPIKE = 6;

/**
 * Synthetic history for a time-series chart: a mid walk (GBM backwards from
 * `mid`, as barBackfill, with the model's volatility and timeScale, plus rare
 * jumps so single spikes exist for downsampling to keep) and a
 * mean-reverting spread (log OU with occasional blowouts). Not reflected in
 * the price band: the history ends at today's price and earlier prices are
 * free to wander. Typed arrays, oldest first.
 */
export const generateHistory = ({
  count,
  intervalMs,
  end,
  mid,
  volatility,
  timeScale,
  tick,
  spreadBps,
  rng,
}: HistoryGenParams): GeneratedHistory => {
  const times = new Float64Array(count);
  const mids = new Float64Array(count);
  const spreads = new Float64Array(count);
  const dt = (intervalMs / 1000) * (timeScale / SECONDS_PER_YEAR);
  const drift = -0.5 * volatility * volatility * dt;
  const diffusion = volatility * Math.sqrt(dt);
  const grid = tick > 0 ? tick / 2 : 0;
  const seconds = intervalMs / 1000;
  const a = Math.min(1, SPREAD_THETA * seconds);
  const level = Math.log(Math.max(spreadBps, 0.1));
  const spreadNoise = SPREAD_SIGMA * Math.sqrt(2 * a);
  const spreadMin = grid > 0 ? (2 * grid * 1e4) / mid : 0;
  let price = mid;
  let logSpread = level;
  const first = end - count * intervalMs;
  for (let k = count - 1; k >= 0; k--) {
    times[k] = first + k * intervalMs;
    mids[k] = grid > 0 ? Math.round(price / grid) * grid : price;
    const spike = rng.next() < SPREAD_SPIKE_RATE ? SPREAD_SPIKE : 1;
    spreads[k] = Math.max(spreadMin, Math.exp(logSpread) * spike);
    let shock = diffusion * rng.normal();
    if (rng.next() < JUMP_RATE) shock += JUMP_SIGMAS * diffusion * rng.normal();
    price /= Math.exp(drift + shock);
    logSpread += a * (level - logSpread) + spreadNoise * rng.normal();
  }
  return { times, mid: mids, spreadBps: spreads };
};
