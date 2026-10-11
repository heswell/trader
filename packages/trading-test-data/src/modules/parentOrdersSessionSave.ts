import { parentOrders, RpcName } from "@heswell/trading-schemas";
import type { Table } from "@heswell/vuu-data-engine-local";
import type { RpcResult } from "@vuu-ui/vuu-protocol-types";

const EDITABLE_COLUMNS = ["quantity", "price"] as const;

type Rpc = (
  rpcName: typeof RpcName.AmendOrder | typeof RpcName.CancelOrder,
  params: Record<string, unknown>,
) => RpcResult;

/**
 * Edit-session parity with the server's OmsRpcHandler: saving a parentOrders
 * edit session sends amendOrder (edited quantity / price) and cancelOrder
 * (deleted rows) to the OMS instead of writing the session rows to the source
 * table. The rows then change only through the resulting execution reports.
 *
 * engine-local applies session rows after this hook, so every handled row's
 * vuuAction is cleared to stop the default write. Errors are thrown, which
 * engine-local returns as the endEditSession ERROR_RESULT.
 */
export const parentOrdersSessionSave =
  (rpc: Rpc) => (sourceTable: Table, sessionTable: Table) => {
    if (sourceTable.name !== parentOrders.name) return;
    const { map } = sessionTable;
    const keyIdx = map[parentOrders.keyField];
    const actionIdx = map.vuuAction;
    const errors: string[] = [];
    for (const row of [...sessionTable.data]) {
      const key = String(row[keyIdx]);
      const action = row[actionIdx];
      if (!action) continue;
      sessionTable.update(key, "vuuAction", "");
      let result: RpcResult | undefined;
      if (action === "deleteRow") {
        result = rpc(RpcName.CancelOrder, { orderId: key });
      } else if (action === "editCell") {
        const current = sourceTable.findByKey(key);
        const params: Record<string, unknown> = { orderId: key };
        for (const column of EDITABLE_COLUMNS) {
          const value = row[map[column]];
          if (current && current[sourceTable.map[column]] !== value) {
            params[column] = value;
          }
        }
        if (Object.keys(params).length > 1) {
          result = rpc(RpcName.AmendOrder, params);
        }
      } else if (action === "addRow") {
        errors.push("addRow: use createOrder to enter orders");
      }
      if (result?.type === "ERROR_RESULT") {
        errors.push(`${key}: ${result.errorMessage}`);
      }
    }
    if (errors.length > 0) throw Error(errors.join("; "));
  };
