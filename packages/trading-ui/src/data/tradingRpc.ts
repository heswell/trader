import {
  parseRpcError,
  type RejectReason,
  type RpcName,
  type RpcRequestParams,
  type RpcResponseData,
} from "@heswell/trading-schemas";
import type { DataSource } from "@vuu-ui/vuu-data-types";
import type { VuuRowDataItemType } from "@vuu-ui/vuu-protocol-types";

/** An RPC ERROR_RESULT, with the server's reason code split out. */
export class TradingRpcError extends Error {
  readonly reason: RejectReason;
  readonly text: string;
  constructor(
    readonly rpcName: RpcName,
    errorMessage: string,
  ) {
    super(errorMessage);
    this.name = "TradingRpcError";
    const { reason, text } = parseRpcError(errorMessage);
    this.reason = reason;
    this.text = text;
  }
}

/**
 * Send a typed trading RPC (createOrder, amendOrder, cancelOrder, cancelAll,
 * exchange admin) through a data source of the owning module (OMS for order
 * RPCs, EXCHANGE for admin). The data source adds the viewport context, so
 * it must be subscribed (e.g. rendered by a Table). Resolves with the response
 * data, rejects with TradingRpcError.
 */
export const sendTradingRpc = async <N extends RpcName>(
  dataSource: DataSource,
  rpcName: N,
  params: RpcRequestParams<N>,
): Promise<RpcResponseData<N>> => {
  if (!dataSource.rpcRequest) {
    throw new TradingRpcError(
      rpcName,
      "INVALID_REQUEST: data source does not support RPC",
    );
  }
  const result = await dataSource.rpcRequest({
    type: "RPC_REQUEST",
    rpcName,
    params: params as unknown as Record<string, VuuRowDataItemType>,
  });
  if (result?.type === "SUCCESS_RESULT") {
    return result.data as RpcResponseData<N>;
  }
  throw new TradingRpcError(
    rpcName,
    result?.errorMessage ?? "INTERNAL_ERROR: no response",
  );
};
