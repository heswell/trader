import {
  AlgoStrategy,
  isTerminalStatus,
  OrdStatus,
} from "@heswell/trading-schemas";
import type { TableCellRendererProps } from "@vuu-ui/vuu-table-types";
import type { FunctionComponent } from "react";
import { registerComponent } from "@vuu-ui/vuu-utils";
import { directionColour } from "../../utils/colours";
import {
  formatNotional,
  formatPrice,
  formatQuantity,
} from "../../utils/formatting";
import { stopTriggerState } from "../../utils/orderStatus";
import { formatTime } from "../../utils/time";
import { FillProgressBar } from "../FillProgressBar";
import { useInstrumentLookup } from "../InstrumentLookup";
import { OrderStatusBadge } from "../OrderStatusBadge";
import { PnlValue } from "../PnlValue";
import { SideLabel } from "../SideLabel";
import { TradingRenderer } from "./rendererNames";

const text = (value: unknown) =>
  typeof value === "string" && value !== "" ? value : undefined;
const num = (value: unknown) => (typeof value === "number" ? value : undefined);

export { TradingRenderer };

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
  const strategy = text(dataRow.strategy);
  // Algo orders still working show where their schedule says they should be.
  const working = !isTerminalStatus(status as OrdStatus);
  const target =
    strategy && strategy !== AlgoStrategy.Dma && working
      ? num(dataRow.targetQty)
      : undefined;
  return (
    <FillProgressBar
      filled={num(dataRow[column.name])}
      muted={status === OrdStatus.Cancelled || status === OrdStatus.Rejected}
      target={target}
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

const DateCell = ({ column, dataRow }: TableCellRendererProps) => {
  const value = num(dataRow[column.name]);
  return value ? (
    <span>{new Date(value).toISOString().slice(0, 10)}</span>
  ) : null;
};

const StopTriggerCell = ({ column, dataRow }: TableCellRendererProps) => {
  const triggeredAt = num(dataRow[column.name]);
  const state = stopTriggerState(
    text(dataRow.ordType),
    text(dataRow.status),
    triggeredAt,
  );
  if (state === "triggered") {
    return (
      <span data-stop-trigger={state} title="Stop triggered">
        {formatTime(triggeredAt, { milliseconds: false })}
      </span>
    );
  }
  return state === "waiting" ? (
    <span data-stop-trigger={state} title="Waiting for a trade at the stop">
      Waiting
    </span>
  ) : null;
};

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
  register(TradingRenderer.Date, DateCell);
  register(TradingRenderer.Liquidity, LiquidityCell);
  register(TradingRenderer.StopTrigger, StopTriggerCell);
};
