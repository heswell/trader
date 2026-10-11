import {
  createTradingLocalServer,
  getTradingTestData,
  setCurrentUser,
} from "@heswell/trading-test-data";
import { connectToVuuServer } from "@heswell/trading-ui";
import { useCallback, useMemo, useState } from "react";

export const REMOTE_CONNECTION_ID = "trading-remote";
const USER = "admin";

export type ShowcaseDataMode = "local" | "remote";
export type RemoteStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

const remoteConnection = () => {
  const ws = window.location.protocol === "https:" ? "wss" : "ws";
  return {
    connectionId: REMOTE_CONNECTION_ID,
    // proxied by the dev server (rsbuild.config.ts) to the trading server
    websocketUrl: `${ws}://${window.location.host}/remote/trading/ws`,
    authUrl: "/remote/trading/authn",
    username: USER,
    // the standalone trading server uses permissive auth (any non-empty password)
    password: USER,
  };
};

/** Local test data (default) or a connection to the standalone trading server. */
export const useShowcaseDataMode = () => {
  const localServer = useMemo(() => {
    setCurrentUser({ name: USER, authorizations: [] });
    return createTradingLocalServer(getTradingTestData());
  }, []);
  const [mode, setMode] = useState<ShowcaseDataMode>("local");
  const [remoteStatus, setRemoteStatus] =
    useState<RemoteStatus>("disconnected");
  const [error, setError] = useState<string>();

  const switchMode = useCallback(
    async (next: ShowcaseDataMode) => {
      setError(undefined);
      if (next === "local") {
        setMode("local");
        return;
      }
      if (remoteStatus === "connected") {
        setMode("remote");
        return;
      }
      setRemoteStatus("connecting");
      try {
        await connectToVuuServer(remoteConnection());
        setRemoteStatus("connected");
        setMode("remote");
      } catch (err) {
        setRemoteStatus("error");
        setError(
          `${String(err)} - is the trading server running? (bun run dev:trading-server)`,
        );
      }
    },
    [remoteStatus],
  );

  return { error, localServer, mode, remoteStatus, switchMode };
};
