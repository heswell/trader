/**
 * Reconnect state per Vuu connection id, published by whoever owns the
 * reconnect loop (VuuConnectionRegistry via observeConnectionRegistry, or
 * ReconnectSupervisor for connectToVuuServer). ConnectionManager only
 * reports the socket ("disconnected", "closed"), never "reconnecting"
 * (trader upstream issue 82), so the status hooks combine both.
 */
export type ReconnectState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "failed"
  | "unauthorized";

export interface ConnectionReconnectInfo {
  connectionId: string;
  state: ReconnectState;
  /** When `state` last changed (ms since epoch). */
  since: number;
  /** Failed attempts in the current reconnect episode, when known. */
  attempt?: number;
  /** When the next attempt is due (ms since epoch), when known. */
  nextAttemptAt?: number;
  /** The last error, for failed / unauthorized. */
  error?: Error;
  /** Attempt now instead of waiting for the backoff timer. */
  retry?: () => void;
}

type Listener = () => void;

const entries = new Map<string, ConnectionReconnectInfo>();
const listeners = new Set<Listener>();
let snapshot: ReadonlyMap<string, ConnectionReconnectInfo> = new Map();

const publish = () => {
  snapshot = new Map(entries);
  for (const listener of listeners) listener();
};

export const connectionStateStore = {
  /** Set (or merge into) the entry for `connectionId`. */
  set(
    connectionId: string,
    info: Omit<ConnectionReconnectInfo, "connectionId" | "since"> & {
      since?: number;
    },
  ) {
    const current = entries.get(connectionId);
    const since =
      info.since ??
      (current && current.state === info.state ? current.since : Date.now());
    entries.set(connectionId, { ...current, ...info, connectionId, since });
    publish();
  },
  delete(connectionId: string) {
    if (entries.delete(connectionId)) publish();
  },
  get(connectionId: string) {
    return snapshot.get(connectionId);
  },
  /** Immutable snapshot, replaced on every change (useSyncExternalStore). */
  getSnapshot: () => snapshot,
  subscribe(listener: Listener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  /** Tests only. */
  reset() {
    entries.clear();
    publish();
  },
};
