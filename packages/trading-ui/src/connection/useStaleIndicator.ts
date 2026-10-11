import { useEffect, useRef, useState } from "react";
import {
  type TradingConnectionState,
  useTradingConnectionStatus,
} from "./useTradingConnectionStatus";

export interface StaleIndicatorOptions {
  /**
   * Any value that changes on each data update (a row timestamp, a version,
   * the rows array). Age is measured on the client clock from when it last
   * changed, so server / simulated clock skew does not matter.
   */
  lastUpdate?: unknown;
  /**
   * Data is stale if `lastUpdate` has not changed for this long (ms).
   * Default: undefined, i.e. only the connection state makes data stale (a
   * quiet instrument is not stale).
   */
  staleAfterMs?: number;
  /** Override the connection to observe (see useTradingConnectionStatus). */
  connectionId?: string;
}

export type StaleReason = "disconnected" | "reconnecting" | "noUpdates";

export interface StaleIndicatorState {
  stale: boolean;
  reason?: StaleReason;
  connectionState: TradingConnectionState;
  /** ms since `lastUpdate` last changed (when staleAfterMs is set). */
  ageMs?: number;
}

/**
 * Whether data shown by a component should be marked stale: the connection
 * is down / reconnecting, or (with `staleAfterMs`) no update for that long.
 * Render with <StaleIndicator> or a `data-stale` attribute.
 */
export const useStaleIndicator = ({
  lastUpdate,
  staleAfterMs,
  connectionId,
}: StaleIndicatorOptions = {}): StaleIndicatorState => {
  const { state: connectionState } = useTradingConnectionStatus(connectionId);
  const changedAt = useRef(Date.now());
  const [now, setNow] = useState(() => Date.now());

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset the age whenever the value changes
  useEffect(() => {
    changedAt.current = Date.now();
    setNow(changedAt.current);
  }, [lastUpdate]);

  useEffect(() => {
    if (staleAfterMs === undefined) return;
    const interval = setInterval(
      () => setNow(Date.now()),
      Math.max(250, Math.min(1_000, staleAfterMs / 4)),
    );
    return () => clearInterval(interval);
  }, [staleAfterMs]);

  if (connectionState !== "connected") {
    return {
      stale: true,
      reason:
        connectionState === "reconnecting" || connectionState === "connecting"
          ? "reconnecting"
          : "disconnected",
      connectionState,
    };
  }
  if (staleAfterMs === undefined) return { stale: false, connectionState };
  const ageMs = Math.max(0, now - changedAt.current);
  return ageMs > staleAfterMs
    ? { stale: true, reason: "noUpdates", connectionState, ageMs }
    : { stale: false, connectionState, ageMs };
};
