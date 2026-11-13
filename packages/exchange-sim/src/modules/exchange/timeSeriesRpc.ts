import {
  RejectReason,
  RpcName,
  rpcError,
  rpcSuccess,
  validateRpcParams,
} from "@heswell/trading-schemas";
import type { RpcResult } from "@vuu-ui/vuu-protocol-types";
import type { ExchangeSimulator } from "../../engine/ExchangeSimulator";
import { TimeSeriesError } from "../../history/TimeSeriesStore";

/**
 * Transport-independent timeSeries RPC (read-only, any user): validate,
 * downsample from the simulator's time-series store, and answer with a
 * contract-shaped SUCCESS_RESULT / ERROR_RESULT.
 */
export const handleTimeSeriesRpc = (
  sim: ExchangeSimulator,
  params: unknown,
): RpcResult => {
  const validated = validateRpcParams(RpcName.TimeSeries, params);
  if (!validated.ok)
    return rpcError(RejectReason.InvalidRequest, validated.errors.join("; "));
  const store = sim.timeSeries;
  if (!store)
    return rpcError(
      RejectReason.InvalidRequest,
      "time series are disabled (exchangeSim.timeSeriesIntervalMs = 0)",
    );
  try {
    return rpcSuccess(
      RpcName.TimeSeries,
      store.query(validated.value, sim.clock()),
    );
  } catch (err) {
    if (err instanceof TimeSeriesError)
      return rpcError(err.reason, err.message);
    return rpcError(RejectReason.InternalError, String(err));
  }
};
