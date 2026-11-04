import {
  AlgoStrategy,
  cumulativeVolume,
  type SessionSchedule,
  sessionWindow,
} from "@heswell/trading-schemas";
import type { AlgoState } from "./params";

/** What a strategy sees when asked for its schedule. */
export interface ScheduleContext {
  algo: AlgoState;
  /** Parent order quantity. */
  quantity: number;
  schedule: SessionSchedule;
}

/**
 * A slicing strategy: how much of the order should be filled by a given
 * time. The container (see AlgoContainer / planSlice) turns the gap between
 * this target and what is filled into child orders.
 */
export interface SliceStrategy {
  /** Quantity that should be filled by `time` (unrounded, 0..quantity). */
  targetQty(ctx: ScheduleContext, time: number): number;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** Fraction of [startAt, endAt] elapsed at `time` (1 when open-ended). */
const linear = ({ startAt, endAt }: AlgoState, time: number) =>
  endAt > startAt ? clamp01((time - startAt) / (endAt - startAt)) : 1;

/** Even slices: the target grows linearly from startAt to endAt. */
export const twap: SliceStrategy = {
  targetQty: ({ algo, quantity }, time) => quantity * linear(algo, time),
};

/**
 * Follow the session's intraday volume curve: the target is the share of the
 * forecast volume between startAt and endAt traded by `time`. With no session
 * schedule the curve is flat, so this is TWAP.
 */
export const vwap: SliceStrategy = {
  targetQty: ({ algo, quantity, schedule }, time) => {
    const window = sessionWindow(schedule, algo.startAt);
    if (!window) return twap.targetQty({ algo, quantity, schedule }, time);
    const length = window.closeAt - window.openAt;
    const share = (t: number) =>
      cumulativeVolume((t - window.openAt) / length, schedule.profile);
    const from = share(algo.startAt);
    const total = share(algo.endAt || window.closeAt) - from;
    if (!(total > 1e-9))
      return twap.targetQty({ algo, quantity, schedule }, time);
    return quantity * clamp01((share(time) - from) / total);
  },
};

/**
 * Percentage of volume: trade `participation` of all market volume, i.e.
 * participation / (1 - participation) of the volume other traders do. The
 * target only depends on volume seen so far, not on `time`.
 */
export const pov: SliceStrategy = {
  targetQty: ({ algo, quantity }) => {
    const p = algo.participation;
    if (!(p > 0 && p < 1)) return 0;
    return Math.min(quantity, (algo.marketVolume * p) / (1 - p));
  },
};

export const SLICE_STRATEGIES: Readonly<
  Record<Exclude<AlgoStrategy, typeof AlgoStrategy.Dma>, SliceStrategy>
> = Object.freeze({
  [AlgoStrategy.Twap]: twap,
  [AlgoStrategy.Vwap]: vwap,
  [AlgoStrategy.Pov]: pov,
});
