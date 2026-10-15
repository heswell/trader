import {
  parseRpcError,
  type RejectReason,
  type RpcName,
  type RpcRequestParams,
  type RpcResponseData,
} from "@heswell/trading-schemas";
import type { DataSource } from "@vuu-ui/vuu-data-types";
import type { VuuRowDataItemType } from "@vuu-ui/vuu-protocol-types";
import type { TradingConnectionState } from "../connection/useTradingConnectionStatus";

/**
 * Why an RPC failed without a server answer: it was not sent because the
 * connection was down, or no answer arrived within the timeout (the request
 * may still have been processed).
 */
export type RpcTransportFailure = "disconnected" | "timeout";

/** An RPC ERROR_RESULT, with the server's reason code split out. */
export class TradingRpcError extends Error {
  readonly reason: RejectReason;
  readonly text: string;
  constructor(
    readonly rpcName: RpcName,
    errorMessage: string,
    /** Set when the server did not answer (no reject from the server). */
    readonly transport?: RpcTransportFailure,
  ) {
    super(errorMessage);
    this.name = "TradingRpcError";
    const { reason, text } = parseRpcError(errorMessage);
    this.reason = reason;
    this.text = text;
  }
}

/** Default time to wait for an RPC answer before failing (ms). */
export const DEFAULT_RPC_TIMEOUT_MS = 10_000;

export interface TradingRpcOptions {
  /** Fail after this long without an answer (ms); 0 waits forever. */
  timeoutMs?: number;
  /** The connection state; anything but "connected" fails without sending. */
  connectionState?: TradingConnectionState;
}

/** Fail-fast error for an RPC attempted while not connected. */
export const disconnectedRpcError = (
  rpcName: RpcName,
  state: TradingConnectionState = "disconnected",
) =>
  new TradingRpcError(
    rpcName,
    `INTERNAL_ERROR: not connected to the server (${state}); ${rpcName} was not sent`,
    "disconnected",
  );

/** Error for an RPC that got no answer within the timeout. */
export const rpcTimeoutError = (rpcName: RpcName, timeoutMs: number) =>
  new TradingRpcError(
    rpcName,
    `INTERNAL_ERROR: no response to ${rpcName} within ${Math.round(timeoutMs / 1000)}s${
      rpcName === "createOrder"
        ? "; the order may have been accepted, check the blotter"
        : "; check the blotter before retrying"
    }`,
    "timeout",
  );

/**
 * Reject with rpcTimeoutError if `promise` has not settled within
 * `timeoutMs` (vuu-ui requests never time out: trader upstream issue 81).
 */
export const withRpcTimeout = <T>(
  promise: Promise<T>,
  rpcName: RpcName,
  timeoutMs = DEFAULT_RPC_TIMEOUT_MS,
): Promise<T> => {
  if (!(timeoutMs > 0) || !Number.isFinite(timeoutMs)) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(rpcTimeoutError(rpcName, timeoutMs)),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
};

/**
 * Send a typed trading RPC (createOrder, amendOrder, cancelOrder, cancelAll,
 * exchange admin) through a data source of the owning module (OMS for order
 * RPCs, EXCHANGE for admin). The data source adds the viewport context, so
 * it must be subscribed (e.g. rendered by a Table). Resolves with the response
 * data, rejects with TradingRpcError: a server reject, or (`transport`) not
 * sent because `connectionState` is not "connected", or no answer within
 * `timeoutMs` (default DEFAULT_RPC_TIMEOUT_MS).
 */
export const sendTradingRpc = async <N extends RpcName>(
  dataSource: DataSource,
  rpcName: N,
  params: RpcRequestParams<N>,
  {
    timeoutMs = DEFAULT_RPC_TIMEOUT_MS,
    connectionState,
  }: TradingRpcOptions = {},
): Promise<RpcResponseData<N>> => {
  if (connectionState !== undefined && connectionState !== "connected") {
    throw disconnectedRpcError(rpcName, connectionState);
  }
  if (!dataSource.rpcRequest) {
    throw new TradingRpcError(
      rpcName,
      "INVALID_REQUEST: data source does not support RPC",
    );
  }
  const result = await withRpcTimeout(
    dataSource.rpcRequest({
      type: "RPC_REQUEST",
      rpcName,
      params: params as unknown as Record<string, VuuRowDataItemType>,
    }),
    rpcName,
    timeoutMs,
  );
  if (result?.type === "SUCCESS_RESULT") {
    return result.data as RpcResponseData<N>;
  }
  throw new TradingRpcError(
    rpcName,
    result?.errorMessage ?? "INTERNAL_ERROR: no response",
  );
};
