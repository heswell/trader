import {
  type LIMITS_RPC_NAMES,
  RejectReason,
  RpcName,
  type RpcRequestParams,
  rpcError,
  rpcSuccess,
  validateRpcParams,
} from "@heswell/trading-schemas";
import type { RpcResult } from "@vuu-ui/vuu-protocol-types";
import type { OmsService } from "../../engine/OmsService";
import type { LimitActor, LimitResult } from "../../limits/LimitMonitor";
import type { TradingUser } from "../../permissions/access";

export type LimitsRpcName = (typeof LIMITS_RPC_NAMES)[number];

const result = <T>(
  r: LimitResult<T>,
  ok: (value: T) => RpcResult,
): RpcResult => (r.ok ? ok(r.value) : rpcError(r.reason, r.text));

const invoke = (
  oms: OmsService,
  rpcName: LimitsRpcName,
  params: unknown,
  actor: LimitActor,
): RpcResult => {
  const monitor = oms.limitMonitor;
  const breach = (r: LimitResult<{ breachId: string; status: string }>) =>
    result(r, ({ breachId, status }) =>
      rpcSuccess(rpcName as "acknowledgeBreach", { breachId, status }),
    );
  const request = (r: LimitResult<{ requestId: string; status: string }>) =>
    result(r, ({ requestId, status }) =>
      rpcSuccess(rpcName as "approveLimitRequest", { requestId, status }),
    );
  switch (rpcName) {
    case RpcName.AcknowledgeBreach: {
      const p = params as RpcRequestParams<"acknowledgeBreach">;
      return breach(monitor.acknowledge(p.breachId, actor, p.comment));
    }
    case RpcName.EscalateBreach: {
      const p = params as RpcRequestParams<"escalateBreach">;
      return breach(monitor.escalate(p.breachId, actor, p.comment));
    }
    case RpcName.CommentBreach: {
      const p = params as RpcRequestParams<"commentBreach">;
      return breach(monitor.comment(p.breachId, actor, p.comment));
    }
    case RpcName.RequestLimitIncrease:
      return request(
        monitor.requestIncrease(
          params as RpcRequestParams<"requestLimitIncrease">,
          actor,
        ),
      );
    case RpcName.ApproveLimitRequest: {
      const p = params as RpcRequestParams<"approveLimitRequest">;
      return request(monitor.approve(p.requestId, actor, p.comment));
    }
    case RpcName.RejectLimitRequest: {
      const p = params as RpcRequestParams<"rejectLimitRequest">;
      return request(monitor.reject(p.requestId, actor, p.comment));
    }
    case RpcName.WithdrawLimitRequest: {
      const p = params as RpcRequestParams<"withdrawLimitRequest">;
      return request(monitor.withdraw(p.requestId, actor));
    }
    case RpcName.KillSwitch: {
      const r = monitor.kill(params as RpcRequestParams<"killSwitch">, actor);
      return result(r, ({ entityId, active, orderIds }) =>
        rpcSuccess(RpcName.KillSwitch, { entityId, active, orderIds }),
      );
    }
    case RpcName.CheckLimits: {
      const r = oms.checkLimits(
        params as RpcRequestParams<"checkLimits">,
        actor.access,
      );
      return result(r, (value) => rpcSuccess(RpcName.CheckLimits, value));
    }
    case RpcName.ReleaseKillSwitch: {
      const p = params as RpcRequestParams<"releaseKillSwitch">;
      return result(monitor.release(p.entityId, actor, p.comment), (row) =>
        rpcSuccess(RpcName.ReleaseKillSwitch, {
          entityId: row.entityId,
          active: row.active,
          orderIds: [],
        }),
      );
    }
  }
};

/**
 * Limits RPCs (breaches, temporary increases, kill switch, the pre-trade
 * check): validated, then applied by the OMS LimitMonitor (checkLimits by
 * the OmsService), which checks what the user may see and do.
 */
export const handleLimitsRpc = (
  oms: OmsService,
  rpcName: LimitsRpcName,
  params: unknown,
  user: TradingUser,
): RpcResult => {
  const validated = validateRpcParams(rpcName, params);
  if (!validated.ok) {
    return rpcError(RejectReason.InvalidRequest, validated.errors.join("; "));
  }
  try {
    return invoke(oms, rpcName, validated.value, {
      user: user.name,
      access: oms.accessFor(user),
    });
  } catch (err) {
    oms.logger.error(`${rpcName} failed`, err);
    return rpcError(RejectReason.InternalError, String(err));
  }
};
