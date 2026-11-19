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
 * remainder at the fill price. `multiplier` is the instrument's contract
 * multiplier: realised P&L is per unit of price times it.
 */
export const applyFill = (
  position: PositionState,
  side: Side,
  qty: number,
  px: number,
  multiplier = 1,
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
  const realizedPnl =
    position.realizedPnl + closed * (px - a0) * Math.sign(q0) * multiplier;
  const avgCost =
    quantity === 0 ? 0 : Math.sign(quantity) === Math.sign(q0) ? a0 : px;
  return { quantity, boughtQty, soldQty, avgCost, realizedPnl };
};

export const markPosition = (
  position: PositionState,
  markPx: number,
  multiplier = 1,
): PositionMarks => {
  const unrealizedPnl =
    position.quantity === 0
      ? 0
      : position.quantity * (markPx - position.avgCost) * multiplier;
  return {
    markPx,
    marketValue: position.quantity * markPx * multiplier,
    unrealizedPnl,
    totalPnl: position.realizedPnl + unrealizedPnl,
  };
};

/** A position's Greeks, in shares (or index units) and USD. */
export interface PositionGreeks {
  /** Shares equivalent: quantity x multiplier (x the option's delta). */
  delta: number;
  /** delta x the underlying's price, in USD. */
  deltaUsd: number;
  /** Change in delta per point of the underlying (options only). */
  gamma: number;
  /** Change in market value (USD) per vol point (options only). */
  vegaUsd: number;
}

export const NO_GREEKS: PositionGreeks = Object.freeze({
  delta: 0,
  deltaUsd: 0,
  gamma: 0,
  vegaUsd: 0,
});

const round = (n: number, dp: number) => {
  const f = 10 ** dp;
  return Math.round(n * f) / f || 0;
};

/**
 * Greeks of `quantity` contracts. An option's come from its model Greeks
 * (Black-76 on the forward, so delta x forward is the spot dollar delta);
 * none is all 0 (an expired option). Anything else is delta one: its
 * delta is the quantity x multiplier and its deltaUsd the market value.
 */
export const positionGreeks = (
  quantity: number,
  multiplier: number,
  usdPerPriceUnit: number,
  option:
    | {
        greeks:
          | { delta: number; gamma: number; vega: number; forward: number }
          | undefined;
      }
    | undefined,
  marketValueUsd: number,
): PositionGreeks => {
  const units = quantity * multiplier;
  if (!option) {
    return {
      delta: round(units, 2),
      deltaUsd: marketValueUsd,
      gamma: 0,
      vegaUsd: 0,
    };
  }
  const { greeks } = option;
  if (!greeks || quantity === 0) return NO_GREEKS;
  const delta = units * greeks.delta;
  return {
    delta: round(delta, 2),
    deltaUsd: round(delta * greeks.forward * usdPerPriceUnit, 2),
    gamma: round(units * greeks.gamma, 4),
    vegaUsd: round((units * greeks.vega * usdPerPriceUnit) / 100, 2),
  };
};
