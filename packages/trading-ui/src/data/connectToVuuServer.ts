import { ConnectionManager } from "@vuu-ui/vuu-data-remote";
import { connectionStateStore } from "../connection/connectionStateStore";
import { ReconnectSupervisor } from "../connection/ReconnectSupervisor";
import type { ReconnectPolicy } from "../connection/reconnectPolicy";
import {
  DEFAULT_LOGIN_TIMEOUT_MS,
  withConnectTimeout,
} from "../connection/resilientConnectionRegistry";

export interface VuuServerConnection {
  connectionId: string;
  /** e.g. ws://localhost:8095/websocket-trading */
  websocketUrl: string;
  /** POST endpoint returning `{ token }`, e.g. http://localhost:8447/api/authn */
  authUrl: string;
  username: string;
  /** Not needed for permissive auth (vuu-server ≥ 4.2). */
  password?: string;
  /**
   * Reconnect after the socket drops (fresh token, same connection id, so
   * viewports resubscribe). Default: backoff 1 s doubling to 30 s with 50%
   * jitter, never giving up. `false` disables (docs/resilience.md).
   */
  reconnect?: ReconnectPolicy | false;
  /** Time allowed per connect attempt (ms); 0 disables. */
  loginTimeoutMs?: number;
}

const supervisors = new Map<
  string,
  { supervisor: ReconnectSupervisor; unsubscribe: () => void }
>();

const LOST = new Set(["disconnected", "connection-failed", "failed"]);
const UP = new Set(["connected", "reconnected"]);

const connectOnce = async ({
  connectionId,
  websocketUrl,
  authUrl,
  username,
  password = "",
  loginTimeoutMs = DEFAULT_LOGIN_TIMEOUT_MS,
}: VuuServerConnection) => {
  const response = await fetch(authUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!response.ok) {
    throw Error(`authentication failed: ${response.status}`);
  }
  const { token } = (await response.json()) as { token?: string };
  if (!token) throw Error("authentication failed: no token");
  const status = await withConnectTimeout(
    ConnectionManager.connectTo(
      connectionId,
      { url: websocketUrl, token, retryLimitStartup: 1 },
      true,
    ),
    connectionId,
    loginTimeoutMs,
  );
  if (status === "connection-failed") {
    throw Error(`unable to connect to ${websocketUrl}`);
  }
  return status;
};

const supervise = (
  connection: VuuServerConnection,
  policy?: ReconnectPolicy,
) => {
  const { connectionId } = connection;
  stopSupervising(connectionId);
  const supervisor = new ReconnectSupervisor({
    policy,
    connect: async () => {
      await connectOnce(connection);
    },
    onChange: ({ state, attempt, nextAttemptAt, error }) => {
      switch (state) {
        case "connected":
          connectionStateStore.set(connectionId, {
            state,
            attempt: undefined,
            nextAttemptAt: undefined,
            error: undefined,
            retry: undefined,
          });
          break;
        case "reconnecting":
        case "failed":
          connectionStateStore.set(connectionId, {
            state,
            attempt,
            nextAttemptAt,
            error,
            retry: () => supervisor.retryNow(),
          });
          break;
        case "stopped":
          connectionStateStore.delete(connectionId);
          break;
      }
    },
  });
  const unsubscribe = ConnectionManager.onConnectionStatus(
    connectionId,
    (status) => {
      if (LOST.has(status)) supervisor.connectionLost();
      else if (UP.has(status)) supervisor.connected();
    },
  );
  supervisors.set(connectionId, { supervisor, unsubscribe });
  supervisor.connected();
};

const stopSupervising = (connectionId: string) => {
  const entry = supervisors.get(connectionId);
  if (!entry) return;
  supervisors.delete(connectionId);
  entry.unsubscribe();
  entry.supervisor.stop();
};

/**
 * Authenticate against a vuu-server REST auth endpoint (permissive auth in
 * dev; the token is read from the JSON body) and open a websocket connection
 * with ConnectionManager. Resolves once connected; rejects on auth or
 * connection failure (or no LOGIN answer within `loginTimeoutMs`).
 *
 * Once connected, a ReconnectSupervisor reconnects after the socket drops
 * (`reconnect`), publishing reconnecting / failed for the status hooks.
 *
 * Inside vuu-portal the host does this - features use mode="inherit".
 */
export const connectToVuuServer = async (connection: VuuServerConnection) => {
  const status = await connectOnce(connection);
  if (connection.reconnect !== false) {
    supervise(connection, connection.reconnect);
  }
  return status;
};

/**
 * Stops supervising (reconnecting) a connection opened by connectToVuuServer
 * and destroys it.
 */
export const disconnectFromVuuServer = (connectionId: string) => {
  stopSupervising(connectionId);
  return ConnectionManager.destroyConnection(connectionId);
};
