import { DefaultRpcHandler, type TableContainer } from "@heswell/vuu-server";
import { EXCHANGE_ADMIN_RPC_NAMES } from "@heswell/trading-schemas";
import type { RpcResult } from "@vuu-ui/vuu-protocol-types";
import type { ExchangeSimulator } from "../../engine/ExchangeSimulator";
import { handleExchangeAdminRpc } from "./exchangeAdminRpc";
import {
  canAdminSim,
  type SimPermissionMode,
  type SimUser,
  simAdminDenied,
} from "./simAdminAccess";

export {
  type ExchangeAdminRpcName,
  handleExchangeAdminRpc,
} from "./exchangeAdminRpc";

/**
 * Vuu RPC handler exposing the EXCHANGE admin RPCs (VIEWPORT_CONTEXT). The
 * caller needs the sim-admin role (see simAdminAccess.ts).
 */
export class ExchangeAdminRpcHandler extends DefaultRpcHandler {
  constructor(
    tableContainer: TableContainer,
    readonly sim: ExchangeSimulator,
  ) {
    super(tableContainer);
    const mode = sim.config.permissionMode as SimPermissionMode;
    for (const rpcName of EXCHANGE_ADMIN_RPC_NAMES) {
      this.registerRpc(rpcName, ({ namedParams, ctx }): RpcResult => {
        const user = ctx.user as SimUser | undefined;
        if (!canAdminSim(user, mode)) {
          return { type: "ERROR_RESULT", errorMessage: simAdminDenied(user) };
        }
        return handleExchangeAdminRpc(sim, rpcName, namedParams);
      });
    }
  }
}
