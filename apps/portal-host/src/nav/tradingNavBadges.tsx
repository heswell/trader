import type { ReactNode } from "react";

/**
 * Live values behind the nav badges, keyed as the catalog's `navBadge`
 * (apps/features/trading/src/catalog.ts). Undefined until loaded.
 */
export interface TradingNavBadgeValues {
  /** Working parent orders visible to the user (Orders blotter, Working tab). */
  "orders.working"?: number;
  /** Sum of `totalPnlUsd` over the positions visible to the user. */
  "positions.dayPnl"?: number;
}

export type TradingNavBadgeKey = keyof TradingNavBadgeValues;

const COMPACT_UNITS = [
  { size: 1e9, suffix: "B" },
  { size: 1e6, suffix: "M" },
  { size: 1e3, suffix: "k" },
] as const;

const MINUS = "\u2212";

/** e.g. 12345 → "+12.3k", -980 → "−980", 0 → "0". */
export const formatCompactSigned = (value: number): string => {
  const abs = Math.abs(value);
  const sign = value > 0 ? "+" : value < 0 ? MINUS : "";
  for (const { size, suffix } of COMPACT_UNITS) {
    if (abs >= size) {
      const scaled = abs / size;
      const digits = scaled >= 100 ? 0 : 1;
      return `${sign}${Number(scaled.toFixed(digits))}${suffix}`;
    }
  }
  const rounded = Math.round(abs);
  return rounded === 0 ? "0" : `${sign}${rounded}`;
};

export const pnlDirection = (value: number) =>
  Math.round(value) > 0 ? "up" : Math.round(value) < 0 ? "down" : "flat";

/**
 * The PortalNav `renderBadge` result for a `navBadge` key. The order count
 * is a number, so PortalNav renders it as a count (a pip in the rail); P&L
 * is a signed, coloured compact value (hidden in the rail).
 */
export const renderTradingNavBadge = (
  navBadge: string | undefined,
  values: TradingNavBadgeValues,
): ReactNode => {
  switch (navBadge) {
    case "orders.working":
      return values["orders.working"];
    case "positions.dayPnl": {
      const pnl = values["positions.dayPnl"];
      if (pnl === undefined) return undefined;
      return (
        <span
          className={`traderNavPnl traderNavPnl-${pnlDirection(pnl)}`}
          title={`P&L ${Math.round(pnl).toLocaleString("en-US")} USD`}
        >
          {formatCompactSigned(pnl)}
        </span>
      );
    }
    default:
      return undefined;
  }
};
