import { useData, useOptionalVuuConnectionId } from "@vuu-ui/core";
import {
  type ConnectionStatus,
  ConnectionManager,
} from "@vuu-ui/vuu-data-remote";
import { useEffect, useState } from "react";
import { useTradingDataMode } from "../data/TradingDataProvider";

/** Connection state, simplified for display. */
export type TradingConnectionState =
  | "connected"
  | "connecting"
  | "reconnecting"
  | "disconnected"
  | "failed";

/** Map a vuu ConnectionStatus to a TradingConnectionState. */
export const toConnectionState = (
  status: ConnectionStatus | string | undefined,
): TradingConnectionState => {
  switch (status) {
    case "connected":
    case "reconnected":
      return "connected";
    case "connecting":
    case "websocket-open":
      return "connecting";
    case "reconnecting":
      return "reconnecting";
    case "failed":
    case "connection-failed":
      return "failed";
    default:
      return "disconnected";
  }
};

export interface TradingConnectionStatus {
  state: TradingConnectionState;
  /** The raw vuu status (undefined for local data). */
  status?: ConnectionStatus;
  connectionId?: string;
  /** True for in-browser data, which is always connected. */
  local: boolean;
  /** When the state last changed (ms since epoch). */
  since: number;
}

const LOCAL: Omit<TradingConnectionStatus, "since"> = {
  state: "connected",
  local: true,
};

/**
 * Connection status of the Vuu server behind the trading data provider
 * (ConnectionManager.onConnectionStatus). In `remote` mode it follows the
 * provider's connectionId; in `inherit` mode the authenticated (portal)
 * connection. Local test data is always "connected".
 * `connectionId` overrides the connection to observe.
 */
export const useTradingConnectionStatus = (
  connectionId?: string,
): TradingConnectionStatus => {
  const { mode, connectionId: modeConnectionId } = useTradingDataMode();
  const vuuConnectionId = useOptionalVuuConnectionId();
  const { isLocalData } = useData();
  const id =
    connectionId ??
    (mode === "remote"
      ? modeConnectionId
      : mode === "inherit" && !isLocalData
        ? vuuConnectionId
        : undefined);

  const [status, setStatus] = useState<TradingConnectionStatus>(() =>
    initialStatus(id),
  );

  useEffect(() => {
    setStatus(initialStatus(id));
    if (id === undefined) return;
    return ConnectionManager.onConnectionStatus(id, (next) => {
      setStatus((current) => {
        const state = toConnectionState(next);
        return state === current.state && next === current.status
          ? current
          : {
              state,
              status: next,
              connectionId: id,
              local: false,
              since: Date.now(),
            };
      });
    });
  }, [id]);
  return status;
};

const initialStatus = (id: string | undefined): TradingConnectionStatus => {
  if (id === undefined) return { ...LOCAL, since: Date.now() };
  // The connection already exists in remote / inherit mode (it was opened
  // before the provider rendered), so this does not create one.
  const status = ConnectionManager.connectionStatusFor(id);
  return {
    state: toConnectionState(status),
    status,
    connectionId: id,
    local: false,
    since: Date.now(),
  };
};
