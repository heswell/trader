import {
  CreateSessionTableRpcHandler,
  InMemSessionDataTable,
  type RpcParams,
  type TableContainer,
} from "@heswell/vuu-server";
import {
  OMS_RPC_NAMES,
  parentOrders,
  RejectReason,
  RpcName,
  type RpcRequestParams,
  rpcError,
  rpcSuccess,
  validateRpcParams,
} from "@heswell/trading-schemas";
import type { RpcResult } from "@vuu-ui/vuu-protocol-types";
import type { OmsResult, RequestContext } from "../../engine/OmsEngine";
import type { OmsService } from "../../engine/OmsService";
import type { TradingUser } from "../../permissions/access";

export type OmsRpcName = (typeof OMS_RPC_NAMES)[number];

const toRpcResult = <N extends OmsRpcName>(
  rpcName: N,
  result: OmsResult<unknown>,
): RpcResult =>
  result.ok
    ? rpcSuccess(rpcName, result.value as never)
    : rpcError(result.reason, result.text);

/**
 * Transport-independent OMS RPC: validate params, check permissions, apply
 * and return a contract-shaped SUCCESS_RESULT / ERROR_RESULT.
 */
export const handleOmsRpc = (
  oms: OmsService,
  rpcName: OmsRpcName,
  params: unknown,
  user: TradingUser,
): RpcResult => {
  const validated = validateRpcParams(rpcName, params);
  if (!validated.ok) {
    return rpcError(RejectReason.InvalidRequest, validated.errors.join("; "));
  }
  const ctx: RequestContext = { user: user.name, access: oms.accessFor(user) };
  const { engine } = oms;
  try {
    switch (rpcName) {
      case RpcName.CreateOrder:
        return toRpcResult(
          rpcName,
          engine.createOrder(
            validated.value as RpcRequestParams<"createOrder">,
            ctx,
          ),
        );
      case RpcName.AmendOrder:
        return toRpcResult(
          rpcName,
          engine.amendOrder(
            validated.value as RpcRequestParams<"amendOrder">,
            ctx,
          ),
        );
      case RpcName.CancelOrder:
        return toRpcResult(
          rpcName,
          engine.cancelOrder(
            validated.value as RpcRequestParams<"cancelOrder">,
            ctx,
          ),
        );
      case RpcName.CancelAll:
        return toRpcResult(
          rpcName,
          engine.cancelAll(
            validated.value as RpcRequestParams<"cancelAll">,
            ctx,
          ),
        );
    }
  } catch (err) {
    console.error(`[OMS] ${rpcName} failed`, err);
    return rpcError(RejectReason.InternalError, String(err));
  }
};

/** Edit-session RPCs inherited from CreateSessionTableRpcHandler. */
const EDIT_SESSION_RPCS = new Set([
  "beginEditSession",
  "createSessionTable",
  "endEditSession",
  "editCell",
  "addRow",
  "deleteRow",
  "deleteSelectedRows",
  "undoRowChange",
]);
const EDITABLE_COLUMNS = new Set(["quantity", "price"]);

const error = (errorMessage: string): RpcResult => ({
  type: "ERROR_RESULT",
  errorMessage,
});

/**
 * Vuu RPC handler for every OMS table (and positionPrices): the order RPCs
 * plus a restricted edit session on parentOrders, where saving the session
 * turns edited quantity / price into amendOrder and deleted rows into
 * cancelOrder (see README "Blotter inline edit").
 */
export class OmsRpcHandler extends CreateSessionTableRpcHandler {
  constructor(
    tableContainer: TableContainer,
    readonly oms: OmsService,
  ) {
    super(tableContainer);
    for (const rpcName of OMS_RPC_NAMES) {
      this.registerRpc(rpcName, ({ namedParams, ctx }) =>
        handleOmsRpc(oms, rpcName, namedParams, ctx.user),
      );
    }
  }

  processRpcRequest(
    rpcName: string,
    params: RpcParams,
  ): RpcResult | Promise<RpcResult> {
    if (EDIT_SESSION_RPCS.has(rpcName)) {
      const guard = this.#guardEditSession(rpcName, params);
      if (guard) return guard;
    }
    return super.processRpcRequest(rpcName, params);
  }

  #guardEditSession(
    rpcName: string,
    { namedParams, viewport }: RpcParams,
  ): RpcResult | undefined {
    const table = viewport.dataTable;
    if (table.tableDef.name !== parentOrders.name) {
      return error(`${rpcName}: only parentOrders supports edit sessions`);
    }
    const isSession = table instanceof InMemSessionDataTable;
    if (rpcName === "beginEditSession" || rpcName === "createSessionTable") {
      return isSession
        ? error(`${rpcName}: already a session table`)
        : undefined;
    }
    // Everything else only ever touches the session copy, never parentOrders itself.
    if (!isSession) return error(`${rpcName}: viewport is not an edit session`);
    if (rpcName === "addRow") {
      return error("addRow: use createOrder to enter orders");
    }
    if (rpcName === "editCell") {
      const column = (namedParams as { column?: string }).column ?? "";
      if (!EDITABLE_COLUMNS.has(column)) {
        return error(`editCell: ${column} is not editable (quantity, price)`);
      }
    }
  }

  /**
   * Save = amend / cancel through the OMS. The source rows are only changed
   * by the resulting execution reports. Stale rows (order changed since the
   * session started) fail unless force is set, as in the default handler.
   */
  protected handleEndEditSession({
    namedParams: { force, save },
    viewport,
    ctx,
  }: RpcParams): RpcResult {
    const sessionTable = viewport.dataTable;
    if (!(sessionTable instanceof InMemSessionDataTable)) {
      return error("endEditSession: viewport is not using a session table");
    }
    if (!save) {
      this.tableContainer.removeSessionTable(sessionTable.name);
      return { type: "SUCCESS_RESULT", data: undefined };
    }
    const prepared = this.prepareSessionSave(sessionTable, Boolean(force));
    if ("type" in prepared) return prepared;

    const errors: string[] = [];
    const results: { orderId: string; action: string; status?: string }[] = [];
    for (const { action, key, cellUpdates } of prepared.changes) {
      if (action === "addRow") continue;
      const isCancel = action === "deleteRow";
      const rpcName = isCancel ? RpcName.CancelOrder : RpcName.AmendOrder;
      const params: Record<string, unknown> = { orderId: key };
      if (!isCancel) {
        for (const column of EDITABLE_COLUMNS) {
          if (column in cellUpdates) params[column] = cellUpdates[column];
        }
        if (Object.keys(params).length === 1) continue;
      }
      const result = handleOmsRpc(this.oms, rpcName, params, ctx.user);
      if (result.type === "ERROR_RESULT") {
        errors.push(`${key}: ${result.errorMessage}`);
      } else {
        const data = (result as { data?: { status?: string } }).data;
        results.push({ orderId: key, action: rpcName, status: data?.status });
      }
    }
    this.tableContainer.removeSessionTable(sessionTable.name);
    return errors.length > 0
      ? error(errors.join("; "))
      : { type: "SUCCESS_RESULT", data: { results } };
  }
}
