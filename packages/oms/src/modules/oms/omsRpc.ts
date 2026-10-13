import {
  type OMS_RPC_NAMES,
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
    oms.logger.error(`${rpcName} failed`, err);
    return rpcError(RejectReason.InternalError, String(err));
  }
};
