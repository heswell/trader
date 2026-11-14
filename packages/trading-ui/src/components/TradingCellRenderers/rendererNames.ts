/**
 * Names of the generic trading cell renderers. Use them as a column
 * `type`:
 *
 * ```ts
 * { name: "status", type: { name: "string", renderer: { name: TradingRenderer.OrderStatus } } }
 * ```
 *
 * They read sibling columns from the same row, so those columns must be in
 * the data source (noted per renderer). `registerTradingCellRenderers()` must
 * have run; the components that use them call it.
 */
export const TradingRenderer = Object.freeze({
  /** needs status; optionally rejectReason and text (tooltip). */
  OrderStatus: "trading.order-status",
  /** BUY / SELL label. */
  Side: "trading.side",
  /** needs cumQty (the column) and quantity, status (for muting). */
  FillProgress: "trading.fill-progress",
  /** Price formatted by the instrument's tick / decimals; needs ric. */
  Price: "trading.price",
  /** Signed, coloured amount with arrow; uses `currency` when present. */
  Pnl: "trading.pnl",
  /** Signed net quantity with Long / Short; */
  PositionQuantity: "trading.position-quantity",
  /** Amount with currency, grouped to 2dp; uses `currency` when present. */
  Notional: "trading.notional",
  /** HH:mm:ss.SSS from an epoch timestamp. */
  Time: "trading.time",
  /** YYYY-MM-DD (UTC) from an epoch timestamp; blank for 0. */
  Date: "trading.date",
  /** ADDED / REMOVED / AUCTION / SETTLEMENT. */
  Liquidity: "trading.liquidity",
  /**
   * A stop order's trigger (the column is triggeredAt): "Waiting" until it
   * triggers, then the trigger time; blank for other types. Needs ordType
   * and status.
   */
  StopTrigger: "trading.stop-trigger",
} as const);
