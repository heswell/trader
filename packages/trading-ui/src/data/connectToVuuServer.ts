import { ConnectionManager } from "@vuu-ui/vuu-data-remote";

export interface VuuServerConnection {
  connectionId: string;
  /** e.g. ws://localhost:8095/websocket-trading */
  websocketUrl: string;
  /** POST endpoint returning `{ token }`, e.g. http://localhost:8447/api/authn */
  authUrl: string;
  username: string;
  /** Not needed for permissive auth (vuu-server ≥ 4.2). */
  password?: string;
}

/**
 * Authenticate against a vuu-server REST auth endpoint (permissive auth in
 * dev; the token is read from the JSON body) and open a websocket connection with ConnectionManager. Resolves
 * once connected; rejects on auth or connection failure.
 *
 * Inside vuu-portal the host does this - features use mode="inherit".
 */
export const connectToVuuServer = async ({
  connectionId,
  websocketUrl,
  authUrl,
  username,
  password = "",
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
  const status = await ConnectionManager.connectTo(
    connectionId,
    { url: websocketUrl, token, retryLimitStartup: 1 },
    true,
  );
  if (status === "connection-failed") {
    throw Error(`unable to connect to ${websocketUrl}`);
  }
  return status;
};

export const disconnectFromVuuServer = (connectionId: string) =>
  ConnectionManager.destroyConnection(connectionId);
