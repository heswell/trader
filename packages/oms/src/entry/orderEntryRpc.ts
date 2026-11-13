import {
  type ORDER_ENTRY_RPC_NAMES,
  RejectReason,
  RpcName,
  type RpcRequestParams,
  rpcError,
  rpcSuccess,
  validateRpcParams,
} from "@heswell/trading-schemas";
import type { RpcResult } from "@vuu-ui/vuu-protocol-types";
import type { OmsResult } from "../engine/OmsEngine";
import type { OmsService } from "../engine/OmsService";
import type { TradingUser } from "../permissions/access";

export type OrderEntryRpcName = (typeof ORDER_ENTRY_RPC_NAMES)[number];

const toRpcResult = (rpcName: OrderEntryRpcName, result: OmsResult<unknown>) =>
  result.ok
    ? rpcSuccess(rpcName, result.value as never)
    : rpcError(result.reason, result.text);

/**
 * Transport-independent order ticket RPCs (openOrderEntry,
 * updateOrderEntry, sendOrder, closeOrderEntry), for the trading server's
 * OmsRpcHandler and the engine-local data.
 */
export const handleOrderEntryRpc = (
  oms: OmsService,
  rpcName: OrderEntryRpcName,
  params: unknown,
  user: TradingUser,
): RpcResult => {
  const validated = validateRpcParams(rpcName, params);
  if (!validated.ok) {
    return rpcError(RejectReason.InvalidRequest, validated.errors.join("; "));
  }
  const entries = oms.orderEntry;
  try {
    switch (rpcName) {
      case RpcName.OpenOrderEntry:
        return toRpcResult(
          rpcName,
          entries.open(
            user,
            validated.value as RpcRequestParams<"openOrderEntry">,
          ),
        );
      case RpcName.UpdateOrderEntry:
        return toRpcResult(
          rpcName,
          entries.update(
            user,
            validated.value as RpcRequestParams<"updateOrderEntry">,
          ),
        );
      case RpcName.SendOrder:
        return toRpcResult(
          rpcName,
          entries.send(user, validated.value as RpcRequestParams<"sendOrder">),
        );
      case RpcName.CloseOrderEntry:
        return toRpcResult(
          rpcName,
          entries.close(
            user,
            (validated.value as RpcRequestParams<"closeOrderEntry">).entryId,
          ),
        );
    }
  } catch (err) {
    oms.logger.error(`${rpcName} failed`, err);
    return rpcError(RejectReason.InternalError, String(err));
  }
};

/**
 * editCell on an orderEntry row (the orderEntryPrices join): checked by
 * OrderEntryService.checkEdit, then applied to the base row.
 */
export const handleOrderEntryEditCell = (
  oms: OmsService,
  params: { key?: unknown; column?: unknown; data?: unknown },
  user: TradingUser,
): RpcResult => {
  const { key, column, data } = params;
  if (typeof key !== "string" || typeof column !== "string") {
    return rpcError(RejectReason.InvalidRequest, "editCell: key and column");
  }
  const result = oms.orderEntry.editCell(user, key, column, data);
  return result.ok
    ? { type: "SUCCESS_RESULT", data: undefined }
    : rpcError(result.reason, result.text);
};
