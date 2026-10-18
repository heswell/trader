import { roundToLot, roundToTick } from "@heswell/trading-schemas";
import type { BackfillBar } from "../publish/BarAggregator";
import { alignStart } from "../publish/BarAggregator";
import type { Random } from "../util/random";
import type { PriceModel } from "./PriceModel";
import { SECONDS_PER_YEAR } from "./PriceModel";

/** GBM sub-steps per synthetic bar (open → high / low → close). */
const SUBSTEPS = 8;
/**
 * Trades per taker order arrival, calibrated against the live market with
 * the default config (takers sweep the touch, some rest passively).
 */
export const TRADES_PER_TAKER_ORDER = 0.6;

export interface BackfillParams {
  model: PriceModel;
  lotSize: number;
  /** Typical trade size (lots already applied). */
  tradeSize: number;
  /** Taker order arrivals per second for the instrument. */
  takerRate: number;
  /** Simulated-time multiplier (`exchangeSim.timeScale`). */
  timeScale: number;
  intervalMs: number;
  /** Bars to generate (closed, oldest first in the result). */
  count: number;
  /** Bars end at the start of the interval containing `now`. */
  now: number;
  rng: Random;
}

/**
 * Plausible closed OHLCV history ending where the price model is now, so
 * charts are not empty on first load. The path is the price model's GBM
 * (same volatility and timeScale) run backwards from the current fair value,
 * reflected in the price band and snapped to the tick grid; volume follows
 * the configured taker rate. Each interval is generated independently, so
 * e.g. 1m and 5m histories are not aggregates of each other. Intervals
 * with no synthetic trades are omitted, as live.
 */
export const generateBackfillBars = ({
  model,
  lotSize,
  tradeSize,
  takerRate,
  timeScale,
  intervalMs,
  count,
  now,
  rng,
}: BackfillParams): BackfillBar[] => {
  const { schedule, volatility: sigma, lowerBand: lo, upperBand: hi } = model;
  const dt = (intervalMs / 1000 / SUBSTEPS) * (timeScale / SECONDS_PER_YEAR);
  const drift = -0.5 * sigma * sigma * dt;
  const diffusion = sigma * Math.sqrt(dt);
  const tradesPerBar = (takerRate * TRADES_PER_TAKER_ORDER * intervalMs) / 1000;
  const firstStart = alignStart(now, intervalMs) - count * intervalMs;
  const result: BackfillBar[] = new Array(count);
  let price = model.fairValue;
  for (let k = count - 1; k >= 0; k--) {
    const close = roundToTick(price, schedule);
    let high = close;
    let low = close;
    for (let i = 0; i < SUBSTEPS; i++) {
      price /= Math.exp(drift + diffusion * rng.normal());
      if (price > hi) price = Math.max(lo, hi - (price - hi));
      else if (price < lo) price = Math.min(hi, lo + (lo - price));
      const onTick = roundToTick(price, schedule);
      if (onTick > high) high = onTick;
      if (onTick < low) low = onTick;
    }
    const open = roundToTick(price, schedule);
    const trades = rng.poisson(tradesPerBar);
    const volume = trades
      ? Math.max(
          lotSize,
          roundToLot(trades * tradeSize * rng.uniform(0.6, 1.4), lotSize),
        )
      : 0;
    const typical = (open + high + low + close) / 4;
    result[k] = {
      start: firstStart + k * intervalMs,
      open,
      high,
      low,
      close,
      volume,
      turnover: volume * typical,
      trades,
    };
  }
  // No-trade intervals are gaps, as in the live aggregation.
  return result.filter((bar) => bar.trades > 0);
};
