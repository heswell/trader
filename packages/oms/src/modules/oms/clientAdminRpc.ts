import { canAdminSim } from "@heswell/exchange-sim/engine";
import {
  type CLIENT_ADMIN_RPC_NAMES,
  RejectReason,
  RpcName,
  type RpcRequestParams,
  rpcError,
  rpcSuccess,
  validateRpcParams,
} from "@heswell/trading-schemas";
import type { RpcResult } from "@vuu-ui/vuu-protocol-types";
import type { OmsService } from "../../engine/OmsService";
import {
  ClientAdminError,
  type ClientActionContext,
} from "../../flow/ClientFlow";
import type { TradingUser } from "../../permissions/access";

export type ClientAdminRpcName = (typeof CLIENT_ADMIN_RPC_NAMES)[number];

const jsonObject = (text: string | undefined) => {
  if (!text) return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ClientAdminError(
      RejectReason.InvalidRequest,
      "params is not valid JSON",
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ClientAdminError(
      RejectReason.InvalidRequest,
      "params must be a JSON object",
    );
  return value as Record<string, unknown>;
};

const invoke = (
  oms: OmsService,
  rpcName: ClientAdminRpcName,
  params: unknown,
  ctx: ClientActionContext,
): RpcResult => {
  const { clients } = oms;
  switch (rpcName) {
    case RpcName.SetClientBotParams: {
      const { name, value, ...selector } =
        params as RpcRequestParams<"setClientBotParams">;
      return rpcSuccess(rpcName, {
        botIds: clients.setParams(selector, name, value, ctx),
      });
    }
    case RpcName.PauseClientBots:
    case RpcName.ResumeClientBots:
      return rpcSuccess(rpcName, {
        botIds: clients.setPaused(
          params as RpcRequestParams<"pauseClientBots">,
          rpcName === RpcName.PauseClientBots,
          ctx,
        ),
      });
    case RpcName.AddClientBot: {
      const p = params as RpcRequestParams<"addClientBot">;
      const bot = clients.add(
        p.persona,
        { account: p.account, params: jsonObject(p.params) },
        ctx,
      );
      return rpcSuccess(rpcName, {
        botId: bot.id,
        account: bot.account.account,
      });
    }
    case RpcName.RemoveClientBot: {
      const p = params as RpcRequestParams<"removeClientBot">;
      return rpcSuccess(rpcName, { botIds: clients.remove(p.botId, ctx) });
    }
    case RpcName.SubmitClientAlgo: {
      const { botId, ...request } =
        params as RpcRequestParams<"submitClientAlgo">;
      const result = clients.submit(botId, request, ctx);
      return result.ok
        ? rpcSuccess(rpcName, result.value)
        : rpcError(result.reason, result.text);
    }
    case RpcName.SetFlowParams: {
      const p = params as RpcRequestParams<"setFlowParams">;
      const value = oms.flow.setParams(p);
      clients.recordFlowChange(p, ctx);
      return rpcSuccess(rpcName, value);
    }
  }
};

/**
 * OMS simulator control RPCs (client bots and the background flow): sim-admin
 * only, validated, applied through ClientFlow and logged in simEvents when
 * the exchange runs in the same process.
 */
export const handleClientAdminRpc = (
  oms: OmsService,
  rpcName: ClientAdminRpcName,
  params: unknown,
  user: TradingUser,
): RpcResult => {
  if (!canAdminSim(user, oms.permissionMode))
    return rpcError(
      RejectReason.PermissionDenied,
      `${user.name} needs the sim-admin role`,
    );
  const validated = validateRpcParams(rpcName, params);
  if (!validated.ok)
    return rpcError(RejectReason.InvalidRequest, validated.errors.join("; "));
  try {
    return invoke(oms, rpcName, validated.value, { user: user.name });
  } catch (err) {
    if (err instanceof ClientAdminError)
      return rpcError(err.reason, err.message);
    oms.logger.error(`${rpcName} failed`, err);
    return rpcError(RejectReason.InternalError, String(err));
  }
};
