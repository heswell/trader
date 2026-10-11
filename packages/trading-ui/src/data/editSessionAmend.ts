import type { DataSource } from "@vuu-ui/vuu-data-types";
import { Range } from "@vuu-ui/vuu-utils";
import { TradingRpcError } from "./tradingRpc";

export interface OrderEdits {
  quantity?: number;
  price?: number;
}

/**
 * Amend / cancel orders through the server edit session on `parentOrders`
 * (`beginEditSession` -> `editCell` / `deleteRow` -> `endEditSession`). The
 * OMS turns changed rows into amendOrder and deleted rows into cancelOrder;
 * only `quantity` and `price` are editable. `parentOrders` is the live
 * OMS viewport's data source. Rejects with TradingRpcError when the save
 * fails (the message carries the per-order reasons).
 */
export const editOrdersInSession = async (
  dataSource: DataSource,
  edits: { amend?: Record<string, OrderEdits>; cancel?: readonly string[] },
) => {
  const session = await dataSource.beginEditSession?.();
  if (!session) {
    throw new TradingRpcError(
      "amendOrder",
      "INVALID_REQUEST: data source does not support edit sessions",
    );
  }
  try {
    await session.subscribe({ range: Range(0, 1) }, () => undefined);
    for (const [orderId, { price, quantity }] of Object.entries(
      edits.amend ?? {},
    )) {
      if (quantity !== undefined) {
        await session.editCell?.(orderId, "quantity", quantity);
      }
      if (price !== undefined)
        await session.editCell?.(orderId, "price", price);
    }
    for (const orderId of edits.cancel ?? []) {
      await session.deleteRow?.(orderId);
    }
    const result = await session.endEditSession?.(true);
    if (result && result.type === "ERROR_RESULT") {
      throw new TradingRpcError("amendOrder", result.errorMessage);
    }
    return result;
  } finally {
    session.unsubscribe();
  }
};
