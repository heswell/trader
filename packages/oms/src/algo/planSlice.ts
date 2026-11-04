import type { TopOfBook } from "@heswell/exchange-sim";
import {
  type OrdStatus,
  roundToLot,
  Side,
  TimeInForce,
  TradingPhase,
  isWorkingStatus,
} from "@heswell/trading-schemas";

/** A live child order, as the slicer sees it. */
export interface SliceChild {
  orderId: string;
  price: number;
  leavesQty: number;
  status: OrdStatus;
  created: number;
}

export interface SliceInput {
  now: number;
  /** Time between slicing decisions (the algo timer). */
  sliceMs: number;
  side: Side;
  /** Parent limit price; 0 = market (no limit). */
  limit: number;
  lotSize: number;
  quantity: number;
  cumQty: number;
  /** Schedule target now, rounded down to a lot. */
  target: number;
  /** Schedule target at the end of the next slice, rounded up to a lot. */
  ahead: number;
  top: TopOfBook | undefined;
  /** Non-terminal children. */
  children: readonly SliceChild[];
  /** Final slices before the end time: cross for any remainder of a lot or more. */
  finishing?: boolean;
}

export interface SliceRequest {
  quantity: number;
  price: number;
  timeInForce: TimeInForce;
}

export interface SlicePlan {
  cancel: string[];
  send?: SliceRequest;
}

/** Most children resting at once. */
export const MAX_LIVE_CHILDREN = 3;
/** Cross the spread when this far behind schedule (share of the order, at least a lot). */
export const CATCH_UP_SHARE = 0.05;

/**
 * One slicing decision. Keep a passive child at the near touch sized to the
 * next slice of the schedule; cross the spread (IOC at the far touch) when
 * more than CATCH_UP_SHARE behind; cancel children when ahead of schedule or
 * when the touch has moved away from them. Never lets filled + working
 * exceed the parent quantity, and never trades through the parent limit.
 */
export const planSlice = (input: SliceInput): SlicePlan => {
  const plan: SlicePlan = { cancel: [] };
  const { top, side, limit, lotSize, quantity, cumQty, children } = input;
  if (!top || top.phase !== TradingPhase.Continuous) return plan;
  const buy = side === Side.Buy;
  const down = (q: number) => Math.max(0, roundToLot(q, lotSize, "down"));

  const near = buy ? top.bid : top.ask;
  const far = buy ? top.ask : top.bid;
  const withinLimit = (px: number) =>
    limit <= 0 || (buy ? px <= limit : px >= limit);
  // Join the near touch (or wait at the limit when the touch is through
  // it). With no near touch, rest at the limit only if that cannot cross.
  const passivePx =
    near > 0
      ? withinLimit(near)
        ? near
        : limit
      : limit > 0 && (far <= 0 || !withinLimit(far))
        ? limit
        : 0;
  const crossPx = far > 0 && withinLimit(far) ? far : 0;

  const working = children.reduce((sum, c) => sum + c.leavesQty, 0);
  const cancellable = children.filter((c) => isWorkingStatus(c.status));
  const room = quantity - cumQty - working;

  const tolerance = input.finishing
    ? lotSize
    : Math.max(lotSize, down(quantity * CATCH_UP_SHARE));
  const behind = input.target - cumQty;
  if (behind >= tolerance && crossPx > 0) {
    plan.cancel = cancellable.map((c) => c.orderId);
    const qty = down(Math.min(behind, room));
    if (qty >= lotSize) {
      plan.send = {
        quantity: qty,
        price: crossPx,
        timeInForce: TimeInForce.ImmediateOrCancel,
      };
    }
    return plan;
  }

  // Ahead of schedule: pull the newest children until back in line.
  let excess = cumQty + working - input.ahead;
  if (excess >= lotSize) {
    for (const child of [...cancellable].sort(
      (a, b) => b.created - a.created,
    )) {
      if (excess < lotSize) break;
      plan.cancel.push(child.orderId);
      excess -= child.leavesQty;
    }
    return plan;
  }

  // Children left behind by the touch are re-placed (next slice).
  let resting = working;
  let live = children.length;
  for (const child of cancellable) {
    if (
      passivePx > 0 &&
      child.price !== passivePx &&
      input.now - child.created >= input.sliceMs
    ) {
      plan.cancel.push(child.orderId);
      resting -= child.leavesQty;
      live--;
    }
  }

  const want = down(Math.min(input.ahead - cumQty - resting, room));
  if (want >= lotSize && passivePx > 0 && live < MAX_LIVE_CHILDREN) {
    plan.send = {
      quantity: want,
      price: passivePx,
      timeInForce: TimeInForce.Day,
    };
  }
  return plan;
};
