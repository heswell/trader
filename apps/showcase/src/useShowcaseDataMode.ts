import {
  createTradingLocalServer,
  getTradingTestData,
  setCurrentUser,
} from "@heswell/trading-test-data";
import { connectToVuuServer } from "@heswell/trading-ui";
import { useCallback, useMemo, useState } from "react";

export const REMOTE_CONNECTION_ID = "trading-remote";
export const SHOWCASE_USER = "admin";
const USER = SHOWCASE_USER;

export type ShowcaseDataMode = "local" | "remote";
export type RemoteStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

// The standalone trading server (permissive auth: no password needed).
// TRADING_REMOTE_* are set in rsbuild.config.ts.
const remoteConnection = () => ({
  connectionId: REMOTE_CONNECTION_ID,
  websocketUrl: process.env.TRADING_REMOTE_WS as string,
  authUrl: process.env.TRADING_REMOTE_AUTH as string,
  username: USER,
});

/** Local test data (default) or a connection to the standalone trading server. */
export const useShowcaseDataMode = () => {
  const localServer = useMemo(() => {
    setCurrentUser({ name: USER, authorizations: [] });
    // ?active=200 simulates more instruments (perf checks)
    const active = Number(
      new URLSearchParams(window.location.search).get("active"),
    );
    return createTradingLocalServer(
      getTradingTestData(
        active > 0 ? { exchange: { activeInstruments: active } } : undefined,
      ),
    );
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
