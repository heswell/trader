import {
  type EXCHANGE_ADMIN_RPC_NAMES,
  RejectReason,
  RpcName,
  type RpcRequestParams,
  type RpcResponseData,
  rpcError,
  rpcSuccess,
  validateRpcParams,
} from "@heswell/trading-schemas";
import type { RpcResult } from "@vuu-ui/vuu-protocol-types";
import type { ActionContext } from "../../engine/control/SimControl";
import {
  ExchangeAdminError,
  type ExchangeSimulator,
} from "../../engine/ExchangeSimulator";

export type ExchangeAdminRpcName = (typeof EXCHANGE_ADMIN_RPC_NAMES)[number];

/** A JSON object param (addBot params, runScenario args), or {}. */
const jsonObject = <T>(
  text: string | undefined,
  field: string,
): Record<string, T> => {
  if (!text) return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ExchangeAdminError(
      RejectReason.InvalidRequest,
      `${field} is not valid JSON`,
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ExchangeAdminError(
      RejectReason.InvalidRequest,
      `${field} must be a JSON object`,
    );
  return value as Record<string, T>;
};

const invoke = (
  sim: ExchangeSimulator,
  rpcName: ExchangeAdminRpcName,
  params: RpcRequestParams<ExchangeAdminRpcName>,
  ctx: ActionContext,
): RpcResponseData<ExchangeAdminRpcName> => {
  const { control } = sim;
  switch (rpcName) {
    case RpcName.SetVolatility: {
      const p = params as RpcRequestParams<"setVolatility">;
      return { rics: control.setVolatility(p.ric, p.volatility, ctx) };
    }
    case RpcName.HaltInstrument: {
      const p = params as RpcRequestParams<"haltInstrument">;
      return { rics: control.haltInstrument(p.ric, p.reason, ctx) };
    }
    case RpcName.ResumeInstrument: {
      const p = params as RpcRequestParams<"resumeInstrument">;
      return { rics: control.resumeInstrument(p.ric, p.auction, ctx) };
    }
    case RpcName.SetBotRate: {
      const p = params as RpcRequestParams<"setBotRate">;
      return { rics: control.setBotRate(p.ric, p.bot, p.rate, ctx) };
    }
    case RpcName.SetMarketPhase: {
      const p = params as RpcRequestParams<"setMarketPhase">;
      return { rics: control.setMarketPhase(p.phase, ctx) };
    }
    case RpcName.SetBotParams: {
      const { name, value, overSecs, ...selector } =
        params as RpcRequestParams<"setBotParams">;
      return {
        rics: control.setBotParams(selector, name, value, overSecs, ctx),
      };
    }
    case RpcName.SetInstrumentParams: {
      const { ric, ...p } = params as RpcRequestParams<"setInstrumentParams">;
      return { rics: control.setInstrumentParams(ric, p, ctx) };
    }
    case RpcName.ShiftFairValue: {
      const p = params as RpcRequestParams<"shiftFairValue">;
      return {
        rics: control.shiftFairValue(p.ric, p.bps, ctx, p.informedSecs),
      };
    }
    case RpcName.PauseBots:
      return {
        rics: control.pauseBots(params as RpcRequestParams<"pauseBots">, ctx),
      };
    case RpcName.ResumeBots:
      return {
        rics: control.resumeBots(params as RpcRequestParams<"resumeBots">, ctx),
      };
    case RpcName.PullQuotes:
      return {
        rics: control.pullQuotes(params as RpcRequestParams<"pullQuotes">, ctx),
      };
    case RpcName.ResetBotStats:
      return {
        rics: control.resetBotStats(
          params as RpcRequestParams<"resetBotStats">,
          ctx,
        ),
      };
    case RpcName.AddBot: {
      const p = params as RpcRequestParams<"addBot">;
      const values = jsonObject<unknown>(p.params, "params");
      const bot = control.addBot(
        p.ric,
        p.kind,
        Object.fromEntries(
          Object.entries(values).map(([k, v]) => [k, String(v)]),
        ),
        ctx,
      );
      return { rics: [p.ric], botId: bot.id };
    }
    case RpcName.RemoveBot: {
      const p = params as RpcRequestParams<"removeBot">;
      return { rics: control.removeBot(p.botId, ctx) };
    }
    case RpcName.RunScenario: {
      const p = params as RpcRequestParams<"runScenario">;
      const rics = p.rics
        ?.split(",")
        .map((r) => r.trim())
        .filter(Boolean);
      const args = jsonObject<number | string>(p.args, "args");
      const run = sim.scenarios.run(p.name, { rics, args }, ctx);
      return { rics: run.targets, runId: run.runId };
    }
    case RpcName.StopScenario: {
      const p = params as RpcRequestParams<"stopScenario">;
      const run = sim.scenarios.stop(p.runId, p.revert === true, ctx);
      return { rics: run.targets };
    }
  }
};

/**
 * Transport-independent admin RPC: validate params, apply to the simulator
 * (recorded in simEvents as `user`), and return a contract-shaped
 * SUCCESS_RESULT / ERROR_RESULT.
 */
export const handleExchangeAdminRpc = (
  sim: ExchangeSimulator,
  rpcName: ExchangeAdminRpcName,
  params: unknown,
  user?: string,
): RpcResult => {
  const validated = validateRpcParams(rpcName, params);
  if (!validated.ok) {
    return rpcError(RejectReason.InvalidRequest, validated.errors.join("; "));
  }
  try {
    const data = invoke(sim, rpcName, validated.value, { user });
    sim.flush();
    return rpcSuccess(rpcName, data);
  } catch (err) {
    if (err instanceof ExchangeAdminError)
      return rpcError(err.reason, err.message);
    return rpcError(RejectReason.InternalError, String(err));
  }
};
