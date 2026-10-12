import type { TableCellRendererProps } from "@vuu-ui/vuu-table-types";
import { registerComponent } from "@vuu-ui/vuu-utils";
import { createContext, useContext } from "react";
import { isOrderAmendable, isOrderCancellable } from "../../utils/orderStatus";

export interface OrderRowActions {
  amend: (orderId: string) => void;
  cancel: (orderId: string) => void;
  highlightOrderId?: string;
}

export const OrderBlotterContext = createContext<OrderRowActions | undefined>(
  undefined,
);

export const ORDER_ACTIONS_RENDERER = "trading.order-actions";

export const OrderActionsCell = ({
  column,
  dataRow,
}: TableCellRendererProps) => {
  const actions = useContext(OrderBlotterContext);
  const orderId = String(dataRow[column.name] ?? "");
  const status = String(dataRow.status ?? "");
  if (!actions) {
    // read-only blotter
    return (
      <span className="tradingOrderBlotter-actions">
        <span className="tradingOrderBlotter-orderId">{orderId}</span>
      </span>
    );
  }
  return (
    <span className="tradingOrderBlotter-actions">
      <span className="tradingOrderBlotter-orderId">{orderId}</span>
      <button
        aria-label={`Amend order ${orderId}`}
        disabled={!isOrderAmendable(status)}
        onClick={(e) => {
          e.stopPropagation();
          actions.amend(orderId);
        }}
        title="Amend"
        type="button"
      >
        ✎
      </button>
      <button
        aria-label={`Cancel order ${orderId}`}
        disabled={!isOrderCancellable(status)}
        onClick={(e) => {
          e.stopPropagation();
          actions.cancel(orderId);
        }}
        title="Cancel"
        type="button"
      >
        ✕
      </button>
    </span>
  );
};

let registered = false;
export const registerOrderActionsRenderer = () => {
  if (registered) return;
  registered = true;
  registerComponent(ORDER_ACTIONS_RENDERER, OrderActionsCell, "cell-renderer", {
    userCanAssign: false,
  });
};
