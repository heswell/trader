import type { TableCellRendererProps } from "@vuu-ui/vuu-table-types";
import { registerComponent } from "@vuu-ui/vuu-utils";
import { createContext, useContext } from "react";
import { formatPrice } from "../../utils/formatting";
import { useInstrumentLookup } from "../InstrumentLookup";

export interface FillsLinkContext {
  onOrderSelect?: (orderId: string) => void;
  highlightOrderId?: string;
}
export const FillsLinkContext = createContext<FillsLinkContext>({});

export const FILL_ORDER_LINK_RENDERER = "trading.order-link";
export const VWAP_PRICE_RENDERER = "trading.vwap-price";

const OrderLinkCell = ({ column, dataRow }: TableCellRendererProps) => {
  const { highlightOrderId, onOrderSelect } = useContext(FillsLinkContext);
  const orderId = dataRow[column.name];
  if (typeof orderId !== "string" || orderId === "") return null;
  return (
    <button
      aria-current={orderId === highlightOrderId ? "true" : undefined}
      className="tradingFillsBlotter-orderLink"
      onClick={(e) => {
        e.stopPropagation();
        onOrderSelect?.(orderId);
      }}
      style={{
        background: "transparent",
        border: "none",
        color: "inherit",
        cursor: "pointer",
        fontWeight: orderId === highlightOrderId ? "bold" : undefined,
        textDecoration: "underline",
      }}
      type="button"
    >
      {orderId}
    </button>
  );
};

/** Price for a fill; for a group row, VWAP = sum(notional) / sum(quantity). */
const VwapPriceCell = ({ column, dataRow }: TableCellRendererProps) => {
  const lookup = useInstrumentLookup();
  const notional = Number(dataRow.notional);
  const quantity = Number(dataRow.quantity);
  const ric = typeof dataRow.ric === "string" ? dataRow.ric : undefined;
  const isGroup = !dataRow.isLeaf;
  const value =
    isGroup && quantity > 0
      ? notional / quantity
      : Number(dataRow[column.name]);
  if (!Number.isFinite(value) || value === 0) return null;
  return (
    <span>
      {isGroup ? "VWAP " : ""}
      {formatPrice(value, ric ? lookup.get(ric) : undefined)}
    </span>
  );
};

let registered = false;
export const registerFillsRenderers = () => {
  if (registered) return;
  registered = true;
  registerComponent(FILL_ORDER_LINK_RENDERER, OrderLinkCell, "cell-renderer", {
    userCanAssign: false,
  });
  registerComponent(VWAP_PRICE_RENDERER, VwapPriceCell, "cell-renderer", {
    userCanAssign: false,
  });
};
