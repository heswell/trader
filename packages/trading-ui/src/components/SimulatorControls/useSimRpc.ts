import type {
  RpcName,
  RpcRequestParams,
  RpcResponseData,
} from "@heswell/trading-schemas";
import type { DataSource } from "@vuu-ui/vuu-data-types";
import { useCallback, useState } from "react";
import { useTradingConnectionStatus } from "../../connection/useTradingConnectionStatus";
import { sendTradingRpc, TradingRpcError } from "../../data/tradingRpc";

export interface SimRpcMessage {
  text: string;
  error: boolean;
}

/**
 * Send simulator control RPCs through `dataSource` (any subscribed EXCHANGE
 * table), keeping the last outcome as a message for the control to show.
 */
export const useSimRpc = (dataSource: DataSource) => {
  const { state: connectionState } = useTradingConnectionStatus();
  const [message, setMessage] = useState<SimRpcMessage>();
  const [pending, setPending] = useState(0);
  const send = useCallback(
    async <N extends RpcName>(
      rpcName: N,
      params: RpcRequestParams<N>,
      done?: string | ((data: RpcResponseData<N>) => string),
    ): Promise<RpcResponseData<N> | undefined> => {
      setPending((n) => n + 1);
      try {
        const data = await sendTradingRpc(dataSource, rpcName, params, {
          connectionState,
        });
        const text =
          typeof done === "function" ? done(data) : (done ?? `${rpcName} done`);
        setMessage({ text, error: false });
        return data;
      } catch (err) {
        const text =
          err instanceof TradingRpcError
            ? err.text || err.message
            : String(err);
        setMessage({ text: `${rpcName} failed: ${text}`, error: true });
        return undefined;
      } finally {
        setPending((n) => n - 1);
      }
    },
    [connectionState, dataSource],
  );
  return { send, message, pending: pending > 0 };
};
