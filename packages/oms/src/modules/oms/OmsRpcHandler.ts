import {
  type CanSaveSessionResult,
  type CellEdit,
  CreateSessionTableRpcHandler,
  type DataTable,
  InMemSessionDataTable,
  type PreparedSessionSave,
  type RequestContext,
  type RpcParams,
  type SessionSaveResult,
  type TableContainer,
  type Viewport,
} from "@heswell/vuu-server";
import {
  CLIENT_ADMIN_RPC_NAMES,
  OMS_RPC_NAMES,
  ORDER_ENTRY_EDITABLE_COLUMNS,
  ORDER_ENTRY_RPC_NAMES,
  orderEntry,
  orderEntryPrices,
  PARENT_ORDER_PROGRESS_COLUMNS,
  parentOrders,
  RejectReason,
  RpcName,
  validateAmend,
} from "@heswell/trading-schemas";
import type { RpcResult } from "@vuu-ui/vuu-protocol-types";
import type { OmsService } from "../../engine/OmsService";
import type { TradingUser } from "../../permissions/access";
import { handleClientAdminRpc } from "./clientAdminRpc";
import { handleOrderEntryRpc } from "../../entry/orderEntryRpc";
import { handleOmsRpc } from "./omsRpc";

export { handleOmsRpc, type OmsRpcName } from "./omsRpc";

const EDITABLE_COLUMNS = ["quantity", "price", "stopPrice"] as const;
const SESSION_RPCS = new Set(["beginEditSession", "createSessionTable"]);

const error = (errorMessage: string): RpcResult => ({
  type: "ERROR_RESULT",
  errorMessage,
});

const isParentOrders = (table: DataTable) =>
  table.tableDef.name === parentOrders.name;

/** orderEntry, or the orderEntryPrices join the ticket edits through. */
const isOrderEntry = (table: DataTable) =>
  table.tableDef.name === orderEntryPrices.name ||
  table.tableDef.name === orderEntry.name;

/**
 * Vuu RPC handler for every OMS table (and positionPrices): the order RPCs
 * plus an edit session on parentOrders, where saving the session turns
 * edited quantity / price / stopPrice into amendOrder and deleted rows into cancelOrder
 * (see README "Blotter inline edit").
 *
 * vuu-server's edit RPCs are secure by default: edits only reach a session
 * table owned by the caller, rows hidden by the permission filter cannot be
 * edited, deleted or copied, and a save fails with "stale update" when a
 * source row changed after it was copied into the session. This class only
 * adds the OMS rules: sessions on parentOrders only, no addRow, quantity and
 * price editable, order validation, trading-execute to save.
 *
 * Stale check: every parentOrders column is compared (the vuu-server
 * default) except PARENT_ORDER_PROGRESS_COLUMNS. The other columns only
 * change on an order event (ack, fill, replace, cancel, reject), and every
 * such event changes what an amend is based on (a fill moves cumQty /
 * leavesQty, another amend bumps version). targetQty ticks with an algo's
 * schedule on the algo timer, so it would make every algo amend stale.
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
    for (const rpcName of ORDER_ENTRY_RPC_NAMES) {
      this.registerRpc(rpcName, ({ namedParams, ctx }) =>
        handleOrderEntryRpc(oms, rpcName, namedParams, ctx.user),
      );
    }
    for (const rpcName of CLIENT_ADMIN_RPC_NAMES) {
      this.registerRpc(rpcName, ({ namedParams, ctx }) =>
        handleClientAdminRpc(oms, rpcName, namedParams, ctx.user),
      );
    }
  }

  protected getStaleColumns(
    ...args: Parameters<CreateSessionTableRpcHandler["getStaleColumns"]>
  ) {
    return super
      .getStaleColumns(...args)
      .filter((name) => !PARENT_ORDER_PROGRESS_COLUMNS.includes(name));
  }

  processRpcRequest(
    rpcName: string,
    params: RpcParams,
  ): RpcResult | Promise<RpcResult> {
    if (
      SESSION_RPCS.has(rpcName) &&
      !isParentOrders(params.viewport.dataTable)
    ) {
      return error(`${rpcName}: only parentOrders supports edit sessions`);
    }
    if (rpcName === "addRow") {
      return error("addRow: use createOrder to enter orders");
    }
    return super.processRpcRequest(rpcName, params);
  }

  /**
   * Order ticket rows are edited directly (no session), through the
   * orderEntryPrices join: the edit is written to orderEntry by
   * OrderEntryService (applyCellEdit), as vuu-websocket's basket
   * constituent join does.
   */
  protected canEditSource(viewport: Viewport) {
    return isOrderEntry(viewport.dataTable);
  }

  protected isEditableColumn(table: DataTable, column: string) {
    if (isOrderEntry(table)) {
      return (ORDER_ENTRY_EDITABLE_COLUMNS as readonly string[]).includes(
        column,
      );
    }
    return (
      table instanceof InMemSessionDataTable &&
      isParentOrders(table) &&
      (EDITABLE_COLUMNS as readonly string[]).includes(column)
    );
  }

  protected applyCellEdit(edit: CellEdit) {
    if (!isOrderEntry(edit.table)) return super.applyCellEdit(edit);
    const result = this.oms.orderEntry.editCell(
      edit.ctx.user as TradingUser,
      edit.key,
      edit.column,
      edit.value,
    );
    if (!result.ok) throw Error(`${result.reason}: ${result.text}`);
  }

  /** The amendOrder validation (lot size, tick, filled quantity, market price). */
  protected validateCellEdit({ column, ctx, key, table, value }: CellEdit) {
    if (isOrderEntry(table)) {
      return this.oms.orderEntry.checkEdit(
        ctx.user as TradingUser,
        key,
        column,
        value,
      );
    }
    const order = this.oms.engine.getOrder(key);
    const instrument = order && this.oms.gateway.getInstrument(order.ric);
    if (!order || !instrument) return undefined;
    const invalid = validateAmend({ [column]: value }, instrument, {
      ordType: order.ordType,
      cumQty: order.state.cumQty,
      side: order.side,
      price: order.state.price,
      stopPrice: order.stopPrice,
    });
    return invalid ? `${invalid.reason}: ${invalid.text}` : undefined;
  }

  protected canSaveSession(
    _viewport: Viewport,
    prepared: PreparedSessionSave,
    ctx: RequestContext,
  ): CanSaveSessionResult {
    const user = ctx.user as TradingUser;
    if (!isParentOrders(prepared.sourceTable)) {
      return "endEditSession: only parentOrders supports edit sessions";
    }
    if (!this.oms.accessFor(user).canExecute) {
      return `${RejectReason.PermissionDenied}: ${user.name} may not trade`;
    }
    return true;
  }

  /**
   * Save = amend / cancel through the OMS. The source rows are only changed
   * by the resulting execution reports. Any OMS reject fails the save, so
   * the session stays open (requests that were accepted are not undone).
   */
  protected applySessionSave(
    sessionTable: InMemSessionDataTable,
    prepared: PreparedSessionSave,
    ctx?: RequestContext,
  ): SessionSaveResult {
    const user = ctx?.user as TradingUser | undefined;
    if (!user) return error("endEditSession: save not authorised");
    const errors: string[] = [];
    const results: { orderId: string; action: string; status?: string }[] = [];
    for (const { action, key, cellUpdates } of prepared.changes) {
      const isCancel = action === "deleteRow";
      const rpcName = isCancel ? RpcName.CancelOrder : RpcName.AmendOrder;
      const params: Record<string, unknown> = { orderId: key };
      if (!isCancel) {
        for (const column of EDITABLE_COLUMNS) {
          if (column in cellUpdates) params[column] = cellUpdates[column];
        }
        if (Object.keys(params).length === 1) continue;
      }
      const result = handleOmsRpc(this.oms, rpcName, params, user);
      if (result.type === "ERROR_RESULT") {
        errors.push(`${key}: ${result.errorMessage}`);
      } else {
        const data = (result as { data?: { status?: string } }).data;
        results.push({ orderId: key, action: rpcName, status: data?.status });
      }
    }
    if (errors.length > 0) return error(errors.join("; "));
    this.tableContainer.removeSessionTable(sessionTable.name);
    return { type: "SUCCESS_RESULT", data: { results } };
  }
}
