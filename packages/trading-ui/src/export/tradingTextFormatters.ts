import type { InstrumentLookup } from "../components/InstrumentLookup";
import { TradingRenderer } from "../components/TradingCellRenderers/rendererNames";
import {
  formatNotional,
  formatPrice,
  formatQuantity,
} from "../utils/formatting";
import { stopTriggerState } from "../utils/orderStatus";
import { formatTime } from "../utils/time";
import type { CellTextFormatters } from "./exportColumns";

const text = (value: unknown) =>
  typeof value === "string" && value !== "" ? value : undefined;
const num = (value: unknown) => (typeof value === "number" ? value : undefined);

const sideText = (side: unknown) =>
  side === "BUY" ? "Buy" : side === "SELL" ? "Sell" : (text(side) ?? "");

/**
 * Text forms of the trading cell renderers (TradingCellRenderers), for CSV
 * export: the same text the cell shows, without the markup. Kept beside the
 * renderers so the two stay in step. `lookup` provides instrument price
 * precision (the Price renderer reads it from InstrumentLookup context).
 */
export const tradingTextFormatters = (
  lookup: InstrumentLookup = new Map(),
): CellTextFormatters => ({
  [TradingRenderer.OrderStatus]: (_value, row) => text(row.status) ?? "",
  [TradingRenderer.Side]: (value) => sideText(value),
  [TradingRenderer.FillProgress]: (value, row) => {
    const filled = num(value);
    const total = num(row.quantity);
    return filled === undefined
      ? ""
      : total
        ? `${formatQuantity(filled)} / ${formatQuantity(total)}`
        : formatQuantity(filled);
  },
  [TradingRenderer.Price]: (value, row) => {
    const price = num(value);
    const ric = text(row.ric);
    return price === undefined || price === 0
      ? ""
      : formatPrice(price, ric ? lookup.get(ric) : undefined);
  },
  [TradingRenderer.Pnl]: (value, row) =>
    formatNotional(value, { currency: text(row.currency), signed: true }),
  [TradingRenderer.PositionQuantity]: (value) => {
    const quantity = num(value);
    if (quantity === undefined) return "";
    const label = quantity > 0 ? "Long" : quantity < 0 ? "Short" : "Flat";
    return `${quantity > 0 ? "+" : ""}${formatQuantity(quantity)} ${label}`;
  },
  [TradingRenderer.Notional]: (value, row) =>
    formatNotional(value, { currency: text(row.currency) }),
  [TradingRenderer.Time]: (value) => formatTime(value),
  [TradingRenderer.Date]: (value) => {
    const ms = num(value);
    return ms ? new Date(ms).toISOString().slice(0, 10) : "";
  },
  [TradingRenderer.Liquidity]: (value) => {
    const liquidity = text(value);
    return liquidity
      ? liquidity.charAt(0) + liquidity.slice(1).toLowerCase()
      : "";
  },
  [TradingRenderer.StopTrigger]: (value, row) => {
    const triggeredAt = num(value);
    const state = stopTriggerState(
      text(row.ordType),
      text(row.status),
      triggeredAt,
    );
    return state === "triggered"
      ? formatTime(triggeredAt, { milliseconds: false })
      : state === "waiting"
        ? "Waiting"
        : "";
  },
});
