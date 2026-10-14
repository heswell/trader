import type { OmsService, TradingUser } from "@heswell/oms/engine";
import { RejectReason, RpcName, validateAmend } from "@heswell/trading-schemas";
import type { EditHooks } from "@heswell/vuu-data-engine-local";
import type { RpcResult } from "@vuu-ui/vuu-protocol-types";

const EDITABLE_COLUMNS: readonly string[] = ["quantity", "price"];

type Rpc = (
  rpcName: typeof RpcName.AmendOrder | typeof RpcName.CancelOrder,
  params: Record<string, unknown>,
  user: TradingUser,
) => RpcResult;

const error = (errorMessage: string): RpcResult => ({
  type: "ERROR_RESULT",
  errorMessage,
});

/**
 * Edit-session parity with the server's OmsRpcHandler (packages/oms): only
 * quantity and price can be edited, and only in a session; edits get the
 * amendOrder validation; saving needs trading-execute and sends amendOrder
 * (edited rows) and cancelOrder (deleted rows) to the OMS instead of writing
 * the session rows to the source table. The source rows then change only
 * through the resulting execution reports.
 *
 * Stale check: every parentOrders column is compared, as on the server. The
 * rows only change on order events, and each one (a fill, another amend)
 * changes what the amend was based on.
 */
export const parentOrdersEditHooks = (
  omsService: OmsService,
  rpc: Rpc,
): EditHooks => ({
  canEditSource: () => false,
  isEditableColumn: (_table, column, ctx) =>
    ctx.sessionTable !== undefined && EDITABLE_COLUMNS.includes(column),
  validateCellEdit: ({ column, key, value }) => {
    const order = omsService.engine.getOrder(key);
    const instrument = order && omsService.gateway.getInstrument(order.ric);
    if (!order || !instrument) return undefined;
    const invalid = validateAmend({ [column]: Number(value) }, instrument, {
      ordType: order.ordType,
      cumQty: order.state.cumQty,
    });
    return invalid ? `${invalid.reason}: ${invalid.text}` : undefined;
  },
  getStaleColumns: (sourceTable, sourceRow, { action, sourceSnapshot }) =>
    !sourceSnapshot || action === "addRow"
      ? []
      : sourceTable.schema.columns
          .map(({ name }) => name)
          .filter(
            (name) =>
              !Object.is(
                sourceSnapshot[sourceTable.map[name]],
                sourceRow[sourceTable.map[name]],
              ),
          ),
  canSaveSession: (_prepared, { user }) =>
    omsService.accessFor(user as TradingUser).canExecute ||
    `${RejectReason.PermissionDenied}: ${user.name} may not trade`,
  applySessionSave: (_sessionTable, { changes }, { user }) => {
    const errors: string[] = [];
    for (const { action, key, cellUpdates } of changes) {
      if (action === "addRow") {
        errors.push("addRow: use createOrder to enter orders");
        continue;
      }
      const isCancel = action === "deleteRow";
      const params: Record<string, unknown> = { orderId: key };
      if (!isCancel) {
        for (const column of EDITABLE_COLUMNS) {
          if (column in cellUpdates) params[column] = cellUpdates[column];
        }
        if (Object.keys(params).length === 1) continue;
      }
      const result = rpc(
        isCancel ? RpcName.CancelOrder : RpcName.AmendOrder,
        params,
        user as TradingUser,
      );
      if (result.type === "ERROR_RESULT") {
        errors.push(`${key}: ${result.errorMessage}`);
      }
    }
    return errors.length > 0 ? error(errors.join("; ")) : undefined;
  },
});
