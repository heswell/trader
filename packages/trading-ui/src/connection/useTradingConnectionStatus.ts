import { useData, useOptionalVuuConnectionId } from "@vuu-ui/core";
import {
  type ConnectionStatus,
  ConnectionManager,
} from "@vuu-ui/vuu-data-remote";
import {
  createContext,
  createElement,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { useTradingDataMode } from "../data/TradingDataProvider";
import {
  type ConnectionReconnectInfo,
  connectionStateStore,
} from "./connectionStateStore";
import { observeDefaultConnectionRegistry } from "./resilientConnectionRegistry";

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

/**
 * Combine the socket status (ConnectionManager) with the reconnect loop's
 * state (connectionStateStore): the socket alone never says "reconnecting"
 * (trader upstream issue 82), and the loop knows when it gave up.
 */
export const combineConnectionState = (
  status: ConnectionStatus | string | undefined,
  info: Pick<ConnectionReconnectInfo, "state"> | undefined,
): TradingConnectionState => {
  const socket = toConnectionState(status);
  switch (info?.state) {
    case "reconnecting":
      return socket === "connected" ? "connected" : "reconnecting";
    case "failed":
    case "unauthorized":
      return socket === "connected" ? "connected" : "failed";
    case "connecting":
      return socket === "connected" ? "connected" : "connecting";
    default:
      return socket;
  }
};

/** Higher is worse; used to aggregate several connections. */
export const CONNECTION_STATE_SEVERITY: Record<TradingConnectionState, number> =
  {
    connected: 0,
    connecting: 1,
    reconnecting: 2,
    disconnected: 3,
    failed: 4,
  };

export const worstConnectionState = (
  states: Iterable<TradingConnectionState>,
): TradingConnectionState => {
  let worst: TradingConnectionState = "connected";
  for (const state of states) {
    if (CONNECTION_STATE_SEVERITY[state] > CONNECTION_STATE_SEVERITY[worst]) {
      worst = state;
    }
  }
  return worst;
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
  /** Failed attempts in the current reconnect episode, when known. */
  attempt?: number;
  /** When the next reconnect attempt is due (ms since epoch), when known. */
  nextAttemptAt?: number;
  /** Why the connection failed, when known. */
  error?: Error;
  /** Reconnect now instead of waiting (while reconnecting / failed). */
  retry?: () => void;
}

const useReconnectInfo = () => {
  observeDefaultConnectionRegistry();
  return useSyncExternalStore(
    connectionStateStore.subscribe,
    connectionStateStore.getSnapshot,
    connectionStateStore.getSnapshot,
  );
};

const socketStatus = (id: string) =>
  ConnectionManager.connectionStatusFor(id) as ConnectionStatus;

/**
 * Socket status of several connections, re-rendering on change. `revision`
 * re-reads and re-subscribes: ConnectionManager.destroyConnection drops every
 * status listener of the id (trader upstream issue 89), so after a failed
 * connect is torn down the replacement connection would go unseen.
 */
const useSocketStatuses = (ids: readonly string[], revision = "") => {
  const key = ids.join("\u0000");
  const [statuses, setStatuses] = useState<
    ReadonlyMap<string, { status: ConnectionStatus; since: number }>
  >(
    () =>
      new Map(
        ids.map((id) => [id, { status: socketStatus(id), since: Date.now() }]),
      ),
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: ids are keyed by `key`
  useEffect(() => {
    setStatuses((current) => {
      const changed =
        current.size !== ids.length ||
        ids.some((id) => current.get(id)?.status !== socketStatus(id));
      if (!changed) return current;
      const now = Date.now();
      return new Map(
        ids.map((id) => [id, { status: socketStatus(id), since: now }]),
      );
    });
    const unsubscribes = ids.map((id) =>
      ConnectionManager.onConnectionStatus(id, (status) => {
        setStatuses((current) => {
          if (current.get(id)?.status === status) return current;
          const next = new Map(current);
          next.set(id, { status, since: Date.now() });
          return next;
        });
      }),
    );
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }, [key, revision]);
  return statuses;
};

const EMPTY: readonly string[] = [];

const statusFor = (
  id: string,
  socket: { status: ConnectionStatus; since: number } | undefined,
  info: ConnectionReconnectInfo | undefined,
): TradingConnectionStatus => {
  const state = combineConnectionState(socket?.status, info);
  const reconnecting =
    state === "reconnecting" ||
    state === "failed" ||
    (state === "connecting" && info?.nextAttemptAt !== undefined);
  return {
    state,
    status: socket?.status,
    connectionId: id,
    local: false,
    since: Math.max(socket?.since ?? 0, info?.since ?? 0) || Date.now(),
    attempt: reconnecting ? info?.attempt : undefined,
    nextAttemptAt: reconnecting ? info?.nextAttemptAt : undefined,
    error: state === "failed" ? info?.error : undefined,
    retry: reconnecting ? info?.retry : undefined,
  };
};

/**
 * Status of each given Vuu connection, plus the worst of them. With no ids,
 * every connection with a reconnect loop (portal, trading, ...).
 */
export const useVuuConnectionStatuses = (connectionIds?: readonly string[]) => {
  const infos = useReconnectInfo();
  const ids = useMemo(
    () => connectionIds ?? [...infos.keys()].sort(),
    [connectionIds, infos],
  );
  const stableIds = useStableIds(ids);
  const revision = stableIds
    .map((id) => infos.get(id)?.state ?? "")
    .join("\u0000");
  const sockets = useSocketStatuses(stableIds, revision);
  return useMemo(() => {
    const statuses = stableIds.map((id) =>
      statusFor(id, sockets.get(id), infos.get(id)),
    );
    return {
      statuses,
      state: worstConnectionState(statuses.map(({ state }) => state)),
    };
  }, [stableIds, sockets, infos]);
};

const useStableIds = (ids: readonly string[]) => {
  const key = ids.join("\u0000");
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by content
  return useMemo(() => (ids.length === 0 ? EMPTY : ids), [key]);
};

const ConnectionStateOverrideContext = createContext<
  TradingConnectionState | undefined
>(undefined);

/**
 * Make useTradingConnectionStatus (and so stale greying, ticket / ladder
 * blocking) report `state` for the components inside: for showcases, demos
 * and tests of disconnected behaviour without a server.
 */
export const TradingConnectionStateOverride = ({
  state,
  children,
}: {
  state?: TradingConnectionState;
  children: ReactNode;
}) =>
  createElement(
    ConnectionStateOverrideContext.Provider,
    { value: state },
    children,
  );

const LOCAL: Omit<TradingConnectionStatus, "since"> = {
  state: "connected",
  local: true,
};

/**
 * Connection status of the Vuu server behind the trading data provider. In
 * `remote` mode it follows the provider's connectionId; in `inherit` mode
 * the authenticated (portal / module) connection. Local test data is always
 * "connected". `connectionId` overrides the connection to observe.
 *
 * Combines ConnectionManager's socket status with the reconnect loop's
 * state (VuuConnectionRegistry or connectToVuuServer's supervisor), so
 * "reconnecting" and "failed" are reported (docs/resilience.md).
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
  const ids = useMemo(() => (id === undefined ? EMPTY : [id]), [id]);
  const { statuses } = useVuuConnectionStatuses(ids);
  const [localSince] = useState(() => Date.now());
  const override = useContext(ConnectionStateOverrideContext);
  if (override !== undefined) {
    return { state: override, local: false, since: localSince };
  }
  return statuses[0] ?? { ...LOCAL, since: localSince };
};
