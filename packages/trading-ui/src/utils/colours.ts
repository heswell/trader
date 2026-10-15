import { OrdStatus, Side, TradingPhase } from "@heswell/trading-schemas";

/**
 * Semantic colours as CSS custom properties. Each `--trading-*` token falls
 * back to a Salt token, so it follows the theme / mode by default and can be
 * overridden by an app (e.g. `.my-app { --trading-buy: teal }`).
 * Use the values in inline styles or CSS (`color: var(--trading-buy)`).
 */
export const TradingColour = Object.freeze({
  buy: "var(--trading-buy, var(--salt-sentiment-positive-foreground-informative))",
  sell: "var(--trading-sell, var(--salt-sentiment-negative-foreground-informative))",
  up: "var(--trading-up, var(--salt-sentiment-positive-foreground-informative))",
  down: "var(--trading-down, var(--salt-sentiment-negative-foreground-informative))",
  neutral: "var(--trading-neutral, var(--salt-content-secondary-foreground))",
  working:
    "var(--trading-status-working, var(--salt-status-info-foreground-informative))",
  filled:
    "var(--trading-status-filled, var(--salt-status-success-foreground-informative))",
  pending:
    "var(--trading-status-pending, var(--salt-status-warning-foreground-informative))",
  rejected:
    "var(--trading-status-rejected, var(--salt-status-error-foreground-informative))",
  done: "var(--trading-status-done, var(--salt-content-secondary-foreground))",
} as const);

/** Colour for an order side: buy / sell, neutral for anything else. */
export const sideColour = (side: unknown) =>
  side === Side.Buy
    ? TradingColour.buy
    : side === Side.Sell
      ? TradingColour.sell
      : TradingColour.neutral;

/** Colour for a signed value (change, P&L): up / down / neutral. */
export const directionColour = (value: unknown) =>
  typeof value !== "number" || value === 0
    ? TradingColour.neutral
    : value > 0
      ? TradingColour.up
      : TradingColour.down;

export type OrderStatusCategory =
  | "pending"
  | "working"
  | "filled"
  | "rejected"
  | "done";

/** Group FIX OrdStatus values for display (colour, icon, filtering). */
export const orderStatusCategory = (status: unknown): OrderStatusCategory => {
  switch (status) {
    case OrdStatus.PendingNew:
    case OrdStatus.PendingCancel:
    case OrdStatus.PendingReplace:
      return "pending";
    case OrdStatus.New:
    case OrdStatus.PartiallyFilled:
    case OrdStatus.Replaced:
      return "working";
    case OrdStatus.Filled:
      return "filled";
    case OrdStatus.Rejected:
      return "rejected";
    default:
      return "done";
  }
};

/** Colour for an order status, by its orderStatusCategory. */
export const orderStatusColour = (status: unknown) =>
  TradingColour[orderStatusCategory(status)];

/**
 * Colour for a trading phase: CONTINUOUS as filled, HALTED as rejected, CLOSED
 * / POST_CLOSE as done, auctions and pre-open as pending.
 */
export const tradingPhaseColour = (phase: unknown) =>
  phase === TradingPhase.Continuous
    ? TradingColour.filled
    : phase === TradingPhase.Halted
      ? TradingColour.rejected
      : phase === TradingPhase.Closed || phase === TradingPhase.PostClose
        ? TradingColour.done
        : TradingColour.pending;
