import { DefaultRpcHandler, type TableContainer } from "@heswell/vuu-server";
import { EXCHANGE_ADMIN_RPC_NAMES } from "@heswell/trading-schemas";
import type { ExchangeSimulator } from "../../engine/ExchangeSimulator";
import { handleExchangeAdminRpc } from "./exchangeAdminRpc";

export {
  type ExchangeAdminRpcName,
  handleExchangeAdminRpc,
} from "./exchangeAdminRpc";

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
