import {
  IMPACT_NOTIONAL_USD,
  IMPACT_REFERENCE_VOL,
  type ImpactParams,
  NO_IMPACT,
  SECONDS_PER_YEAR,
} from "./PriceModel";

/**
 * Variance of one wall second's signed aggressive notional, in units of the
 * taker base notional squared, per taker order/s: the order mix, exponential
 * sizes, multi-level sweeps and market makers crossing after a move.
 * Measured with the default roster and impact on
 * (scripts/impactCalibration.ts); calibrateImpact() relies on it.
 */
export const TAKER_FLOW_FACTOR = 4.8;

export interface ImpactConfig {
  /** Share of total variance that comes from flow (0 = no impact). */
  impactVolShare: number;
  impactPermanentShare: number;
  impactHalfLifeSec: number;
  /** Simulated seconds per wall-clock second. */
  timeScale: number;
}

export interface ImpactCalibration {
  impact: ImpactParams;
  /** Share of the variance left to the walk itself. */
  walkVolShare: number;
}

/**
 * Impact constant `k` for one instrument, fixed at startup from the
 * default flow: impact from `takerRate` orders/s of about `takerNotionalUsd`
 * each supplies `impactVolShare` of the model's variance over horizons
 * shorter than the half-life (what charts and realised volatility show),
 * and the walk supplies the rest. Over longer horizons the transient part
 * fades, so long-run volatility is a little lower. `k` does not depend on volatility (impact
 * scales with it), and stays fixed when rates change later, so more flow
 * means more volatility.
 */
export const calibrateImpact = (
  config: ImpactConfig,
  takerRate: number,
  takerNotionalUsd: number,
): ImpactCalibration => {
  const share = config.impactVolShare;
  const permanent = config.impactPermanentShare;
  const halfLifeSec = config.impactHalfLifeSec;
  const flow =
    takerRate *
    TAKER_FLOW_FACTOR *
    (takerNotionalUsd / IMPACT_NOTIONAL_USD) ** 2;
  if (!(share > 0) || !(flow > 0) || !(permanent > 0)) {
    return {
      impact: { ...NO_IMPACT, permanentShare: permanent, halfLifeSec },
      walkVolShare: 1,
    };
  }
  // impact variance per wall second: flow * (k * vol / REF)^2
  // target: share * vol^2 * timeScale / SECONDS_PER_YEAR
  const k =
    IMPACT_REFERENCE_VOL *
    Math.sqrt((share * config.timeScale) / (SECONDS_PER_YEAR * flow));
  return {
    impact: { k, permanentShare: permanent, halfLifeSec },
    walkVolShare: 1 - share,
  };
};
