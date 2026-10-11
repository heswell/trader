import { OrdStatus } from "@heswell/trading-schemas";
import type { TableCellRendererProps } from "@vuu-ui/vuu-table-types";
import type { FunctionComponent } from "react";
import { registerComponent } from "@vuu-ui/vuu-utils";
import { directionColour } from "../../utils/colours";
import {
  formatNotional,
  formatPrice,
  formatQuantity,
} from "../../utils/formatting";
import { formatTime } from "../../utils/time";
import { FillProgressBar } from "../FillProgressBar";
import { useInstrumentLookup } from "../InstrumentLookup";
import { OrderStatusBadge } from "../OrderStatusBadge";
import { PnlValue } from "../PnlValue";
import { SideLabel } from "../SideLabel";

const text = (value: unknown) =>
  typeof value === "string" && value !== "" ? value : undefined;
const num = (value: unknown) => (typeof value === "number" ? value : undefined);

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
  /** ADDED / REMOVED / AUCTION. */
  Liquidity: "trading.liquidity",
} as const);

const OrderStatusCell = ({ dataRow }: TableCellRendererProps) => (
  <OrderStatusBadge
    rejectReason={text(dataRow.rejectReason)}
    status={text(dataRow.status)}
    text={text(dataRow.text)}
  />
);

const SideCell = ({ column, dataRow }: TableCellRendererProps) => (
  <SideLabel side={text(dataRow[column.name])} />
);

const FillProgressCell = ({ column, dataRow }: TableCellRendererProps) => {
  const status = text(dataRow.status);
  return (
    <FillProgressBar
      filled={num(dataRow[column.name])}
      muted={status === OrdStatus.Cancelled || status === OrdStatus.Rejected}
      total={num(dataRow.quantity)}
    />
  );
};

const PriceCell = ({ column, dataRow }: TableCellRendererProps) => {
  const lookup = useInstrumentLookup();
  const ric = text(dataRow.ric);
  const value = num(dataRow[column.name]);
  return (
    <span className="tradingPrice">
      {value === undefined || value === 0
        ? ""
        : formatPrice(value, ric ? lookup.get(ric) : undefined)}
    </span>
  );
};

const PnlCell = ({ column, dataRow }: TableCellRendererProps) => (
  <PnlValue
    currency={text(dataRow.currency)}
    value={num(dataRow[column.name])}
  />
);

const PositionQuantityCell = ({ column, dataRow }: TableCellRendererProps) => {
  const quantity = num(dataRow[column.name]);
  if (quantity === undefined) return null;
  const label = quantity > 0 ? "Long" : quantity < 0 ? "Short" : "Flat";
  return (
    <span
      data-position={label.toLowerCase()}
      style={{ color: directionColour(quantity) }}
    >
      {quantity > 0 ? "+" : ""}
      {formatQuantity(quantity)} <small>{label}</small>
    </span>
  );
};

const NotionalCell = ({ column, dataRow }: TableCellRendererProps) => (
  <span>
    {formatNotional(dataRow[column.name], {
      currency: text(dataRow.currency),
    })}
  </span>
);

const TimeCell = ({ column, dataRow }: TableCellRendererProps) => (
  <span>{formatTime(dataRow[column.name])}</span>
);

const LiquidityCell = ({ column, dataRow }: TableCellRendererProps) => {
  const value = text(dataRow[column.name]);
  return value ? (
    <span data-liquidity={value}>
      {value.charAt(0) + value.slice(1).toLowerCase()}
    </span>
  ) : null;
};

let registered = false;

/** Register the generic trading cell renderers with the vuu component registry (idempotent). */
export const registerTradingCellRenderers = () => {
  if (registered) return;
  registered = true;
  const register = (
    name: string,
    Cell: FunctionComponent<TableCellRendererProps>,
  ) => registerComponent(name, Cell, "cell-renderer", { userCanAssign: false });
  register(TradingRenderer.OrderStatus, OrderStatusCell);
  register(TradingRenderer.Side, SideCell);
  register(TradingRenderer.FillProgress, FillProgressCell);
  register(TradingRenderer.Price, PriceCell);
  register(TradingRenderer.Pnl, PnlCell);
  register(TradingRenderer.PositionQuantity, PositionQuantityCell);
  register(TradingRenderer.Notional, NotionalCell);
  register(TradingRenderer.Time, TimeCell);
  register(TradingRenderer.Liquidity, LiquidityCell);
};
