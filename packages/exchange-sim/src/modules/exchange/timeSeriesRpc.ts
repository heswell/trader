import {
  type EXCHANGE_QUERY_RPC_NAMES,
  RejectReason,
  RpcName,
  type RpcRequestParams,
  rpcError,
  rpcSuccess,
  validateRpcParams,
} from "@heswell/trading-schemas";
import type { RpcResult } from "@vuu-ui/vuu-protocol-types";
import type { ExchangeSimulator } from "../../engine/ExchangeSimulator";
import { TimeSeriesError } from "../../history/TimeSeriesStore";

export type TimeSeriesRpcName = (typeof EXCHANGE_QUERY_RPC_NAMES)[number];

const disabled = () =>
  rpcError(
    RejectReason.InvalidRequest,
    "time series are disabled (exchangeSim.timeSeriesIntervalMs = 0)",
  );

/**
 * Transport-independent time-series RPCs (read-only market data, any user):
 * - `timeSeries`: a one-shot downsampled query (export, benches);
 * - `setTimeSeriesWindow` / `closeTimeSeries`: open, move and close a
 *   subscription whose buckets stream as `timeSeriesBuckets` rows.
 * `user` owns the subscriptions it opens.
 */
export const handleTimeSeriesRpc = (
  sim: ExchangeSimulator,
  rpcName: TimeSeriesRpcName,
  params: unknown,
  user = "",
): RpcResult => {
  const validated = validateRpcParams(rpcName, params);
  if (!validated.ok)
    return rpcError(RejectReason.InvalidRequest, validated.errors.join("; "));
  const store = sim.timeSeries;
  if (!store) return disabled();
  try {
    switch (rpcName) {
      case RpcName.TimeSeries:
        return rpcSuccess(
          rpcName,
          store.query(
            validated.value as RpcRequestParams<"timeSeries">,
            sim.clock(),
          ),
        );
      case RpcName.SetTimeSeriesWindow: {
        const buckets = sim.timeSeriesBuckets;
        if (!buckets) return disabled();
        return rpcSuccess(
          rpcName,
          buckets.setWindow(
            validated.value as RpcRequestParams<"setTimeSeriesWindow">,
            sim.clock(),
            user,
          ),
        );
      }
      case RpcName.CloseTimeSeries: {
        const { subId } =
          validated.value as RpcRequestParams<"closeTimeSeries">;
        sim.timeSeriesBuckets?.close(subId, user);
        return rpcSuccess(rpcName, { subId });
      }
    }
  } catch (err) {
    if (err instanceof TimeSeriesError)
      return rpcError(err.reason, err.message);
    return rpcError(RejectReason.InternalError, String(err));
  }
  return rpcError(RejectReason.InvalidRequest, `unknown rpc ${rpcName}`);
};
