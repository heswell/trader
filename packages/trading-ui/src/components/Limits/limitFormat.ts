import {
  LIMIT_METRIC_INFO,
  LimitMetric,
  LimitState,
} from "@heswell/trading-schemas";

/** Compact amount: 1.25m, 400k, 120. */
export const formatLimitAmount = (value: unknown) => {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${+(value / 1e9).toFixed(2)}bn`;
  if (abs >= 1e6) return `${+(value / 1e6).toFixed(2)}m`;
  if (abs >= 1e3) return `${+(value / 1e3).toFixed(1)}k`;
  return `${+value.toFixed(2)}`;
};

/** A metric's label, e.g. "Position notional"; the value itself if unknown. */
export const metricLabel = (metric: unknown) =>
  typeof metric === "string" && metric in LIMIT_METRIC_INFO
    ? LIMIT_METRIC_INFO[metric as LimitMetric].label
    : String(metric ?? "");

/** "Position notional · BARC.L" (the RIC of a carve-out, if any). */
export const limitLabel = (metric: unknown, ric?: unknown) =>
  typeof ric === "string" && ric !== ""
    ? `${metricLabel(metric)} · ${ric}`
    : metricLabel(metric);

/** Monitor families: which metrics each Show family toggle keeps. */
export const LIMIT_FAMILIES = Object.freeze({
  order: [
    LimitMetric.OrderQty,
    LimitMetric.OrderNotional,
    LimitMetric.OrderRate,
  ],
  position: [LimitMetric.PositionNotional, LimitMetric.GrossPositionNotional],
  risk: [LimitMetric.NetDelta],
  pnl: [LimitMetric.DailyLoss],
} as const);
export type LimitFamily = keyof typeof LIMIT_FAMILIES | "all";

export const LIMIT_STATE_LABEL: Readonly<Record<string, string>> = {
  [LimitState.Ok]: "OK",
  [LimitState.Warning]: "Warning",
  [LimitState.SoftBreach]: "Soft",
  [LimitState.HardBreach]: "Hard",
};

/** Percent of the limit: 0.912 -> "91%". */
export const formatUtilisation = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value)
    ? `${Math.round(value * 100)}%`
    : "";

/** Vuu filter for the metrics of a family ("" = all). */
export const familyFilter = (family: LimitFamily) =>
  family === "all"
    ? ""
    : `metric in [${LIMIT_FAMILIES[family].map((m) => `"${m}"`).join(",")}]`;
