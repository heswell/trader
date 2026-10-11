import { DefaultRpcHandler, type TableContainer } from "@heswell/vuu-server";
import {
  EXCHANGE_ADMIN_RPC_NAMES,
  RejectReason,
  RpcName,
  type RpcRequestParams,
  rpcError,
  rpcSuccess,
  validateRpcParams,
} from "@heswell/trading-schemas";
import type { RpcResult } from "@vuu-ui/vuu-protocol-types";
import {
  ExchangeAdminError,
  type ExchangeSimulator,
} from "../../engine/ExchangeSimulator";

export type ExchangeAdminRpcName = (typeof EXCHANGE_ADMIN_RPC_NAMES)[number];

const invoke = (
  sim: ExchangeSimulator,
  rpcName: ExchangeAdminRpcName,
  params: RpcRequestParams<ExchangeAdminRpcName>,
): string[] => {
  switch (rpcName) {
    case RpcName.SetVolatility: {
      const p = params as RpcRequestParams<"setVolatility">;
      return sim.setVolatility(p.ric, p.volatility);
    }
    case RpcName.HaltInstrument: {
      const p = params as RpcRequestParams<"haltInstrument">;
      return sim.haltInstrument(p.ric, p.reason);
    }
    case RpcName.ResumeInstrument: {
      const p = params as RpcRequestParams<"resumeInstrument">;
      return sim.resumeInstrument(p.ric, p.auction);
    }
    case RpcName.SetBotRate: {
      const p = params as RpcRequestParams<"setBotRate">;
      return sim.setBotRate(p.ric, p.bot, p.rate);
    }
  }
};

/**
 * Transport-independent admin RPC: validate params, apply to the simulator,
 * and return a contract-shaped SUCCESS_RESULT / ERROR_RESULT.
 */
export const handleExchangeAdminRpc = (
  sim: ExchangeSimulator,
  rpcName: ExchangeAdminRpcName,
  params: unknown,
): RpcResult => {
  const validated = validateRpcParams(rpcName, params);
  if (!validated.ok) {
    return rpcError(RejectReason.InvalidRequest, validated.errors.join("; "));
  }
  try {
    const rics = invoke(sim, rpcName, validated.value);
    sim.flush();
    return rpcSuccess(rpcName, { rics });
  } catch (err) {
    if (err instanceof ExchangeAdminError)
      return rpcError(err.reason, err.message);
    return rpcError(RejectReason.InternalError, String(err));
  }
};

/** Vuu RPC handler exposing the EXCHANGE admin RPCs (VIEWPORT_CONTEXT). */
export class ExchangeAdminRpcHandler extends DefaultRpcHandler {
  constructor(
    tableContainer: TableContainer,
    readonly sim: ExchangeSimulator,
  ) {
    super(tableContainer);
    for (const rpcName of EXCHANGE_ADMIN_RPC_NAMES) {
      this.registerRpc(rpcName, ({ namedParams }) =>
        handleExchangeAdminRpc(sim, rpcName, namedParams),
      );
    }
  }
}
