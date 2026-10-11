import type { Side } from "@heswell/trading-schemas";

/** Position state for one account|ric (average-cost method). */
export interface PositionState {
  /** Net quantity, +long / -short. */
  readonly quantity: number;
  readonly boughtQty: number;
  readonly soldQty: number;
  /** Average cost of the open quantity (0 when flat). */
  readonly avgCost: number;
  readonly realizedPnl: number;
}

export interface PositionMarks {
  readonly markPx: number;
  readonly marketValue: number;
  readonly unrealizedPnl: number;
  readonly totalPnl: number;
}

export const FLAT_POSITION: PositionState = Object.freeze({
  quantity: 0,
  boughtQty: 0,
  soldQty: 0,
  avgCost: 0,
  realizedPnl: 0,
});

/**
 * Apply a fill using average cost. Increasing the position re-averages the
 * cost; reducing it realises (fillPx - avgCost) per unit closed (sign-adjusted
 * for shorts) and leaves avgCost unchanged; crossing through flat opens the
 * remainder at the fill price.
 */
export const applyFill = (
  position: PositionState,
  side: Side,
  qty: number,
  px: number,
): PositionState => {
  const signed = side === "BUY" ? qty : -qty;
  const { quantity: q0, avgCost: a0 } = position;
  const boughtQty = position.boughtQty + (signed > 0 ? qty : 0);
  const soldQty = position.soldQty + (signed < 0 ? qty : 0);
  const quantity = q0 + signed;

  if (q0 === 0 || Math.sign(q0) === Math.sign(signed)) {
    const avgCost = (Math.abs(q0) * a0 + qty * px) / Math.abs(quantity);
    return { ...position, quantity, boughtQty, soldQty, avgCost };
  }
  const closed = Math.min(qty, Math.abs(q0));
  const realizedPnl = position.realizedPnl + closed * (px - a0) * Math.sign(q0);
  const avgCost =
    quantity === 0 ? 0 : Math.sign(quantity) === Math.sign(q0) ? a0 : px;
  return { quantity, boughtQty, soldQty, avgCost, realizedPnl };
};

export const markPosition = (
  position: PositionState,
  markPx: number,
): PositionMarks => {
  const unrealizedPnl =
    position.quantity === 0
      ? 0
      : position.quantity * (markPx - position.avgCost);
  return {
    markPx,
    marketValue: position.quantity * markPx,
    unrealizedPnl,
    totalPnl: position.realizedPnl + unrealizedPnl,
  };
};
