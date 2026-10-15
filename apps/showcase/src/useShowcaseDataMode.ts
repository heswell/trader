import { getTradingTestData, setCurrentUser } from "@heswell/trading-test-data";
import { createTradingLocalServer } from "@heswell/trading-test-data/react";
import { connectToVuuServer } from "@heswell/trading-ui";
import { useCallback, useEffect, useRef, useState } from "react";

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
// TRADING_REMOTE_* are set in rsbuild.config.ts; ?ws= / ?auth= override them
// (packages/perf runs its server on free ports).
const remoteConnection = () => {
  const params = new URLSearchParams(window.location.search);
  return {
    connectionId: REMOTE_CONNECTION_ID,
    websocketUrl: params.get("ws") ?? (process.env.TRADING_REMOTE_WS as string),
    authUrl: params.get("auth") ?? (process.env.TRADING_REMOTE_AUTH as string),
    username: USER,
  };
};

/**
 * Exchange-sim overrides from the URL, for perf runs (packages/perf):
 * ?active=200 simulates more instruments, ?mmRate= / ?takerRate= /
 * ?publishMs= raise the tick rate.
 */
const localDataOptions = () => {
  const params = new URLSearchParams(window.location.search);
  const num = (name: string) => {
    const value = Number(params.get(name));
    return value > 0 ? value : undefined;
  };
  const exchange = Object.fromEntries(
    Object.entries({
      activeInstruments: num("active"),
      mmRate: num("mmRate"),
      takerRate: num("takerRate"),
      publishIntervalMs: num("publishMs"),
    }).filter(([, value]) => value !== undefined),
  );
  return Object.keys(exchange).length ? { exchange } : undefined;
};

/** Local test data (default) or a connection to the standalone trading server. */
export const useShowcaseDataMode = () => {
  // ?data=remote starts on the remote server (perf runs) without creating the
  // local test data, whose simulator would otherwise tick in this thread
  const [mode, setMode] = useState<ShowcaseDataMode>(() =>
    new URLSearchParams(window.location.search).get("data") === "remote"
      ? "remote"
      : "local",
  );
  const localServerRef =
    useRef<ReturnType<typeof createTradingLocalServer>>(undefined);
  if (mode === "local" && !localServerRef.current) {
    setCurrentUser({ name: USER, authorizations: [] });
    localServerRef.current = createTradingLocalServer(
      getTradingTestData(localDataOptions()),
    );
  }
  const localServer = localServerRef.current;
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

  useEffect(() => {
    if (mode === "remote" && remoteStatus === "disconnected") {
      setRemoteStatus("connecting");
      connectToVuuServer(remoteConnection())
        .then(() => setRemoteStatus("connected"))
        .catch((err) => {
          setRemoteStatus("error");
          setError(String(err));
        });
    }
  }, [mode, remoteStatus]);

  return { error, localServer, mode, remoteStatus, switchMode };
};
