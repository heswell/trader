import { Button } from "@salt-ds/core";
import { useComponentCssInjection } from "@salt-ds/styles";
import { useWindow } from "@salt-ds/window";
import cx from "clsx";
import {
  forwardRef,
  type HTMLAttributes,
  type ReactNode,
  useEffect,
  useState,
} from "react";
import {
  type TradingConnectionState,
  type TradingConnectionStatus,
  useVuuConnectionStatuses,
} from "../../connection/useTradingConnectionStatus";

import connectionStatusIndicatorCss from "./ConnectionStatusIndicator.css";

const classBase = "tradingConnectionStatus";

export const CONNECTION_STATE_LABELS: Record<TradingConnectionState, string> = {
  connected: "Connected",
  connecting: "Connecting…",
  reconnecting: "Reconnecting…",
  disconnected: "Disconnected",
  failed: "Connection failed",
};

export interface ConnectionStatusIndicatorProps
  extends Omit<HTMLAttributes<HTMLSpanElement>, "children"> {
  /**
   * Connections to summarise (the worst state is shown). Default: every
   * connection with a reconnect loop (the portal's and each module's).
   */
  connectionIds?: readonly string[];
  /** Show this state instead of observing (tests, showcase). */
  state?: TradingConnectionState;
  /** Labels per state (overrides the defaults). */
  labels?: Partial<Record<TradingConnectionState, ReactNode>>;
  /** Hide the label while connected (dot only). Default false. */
  compact?: boolean;
  /** Show "Retry now" while reconnecting / failed. Default true. */
  showRetry?: boolean;
}

const useNow = (active: boolean) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(interval);
  }, [active]);
  return now;
};

const describe = (statuses: TradingConnectionStatus[]) =>
  statuses
    .map(
      ({ connectionId, state, attempt }) =>
        `${connectionId}: ${CONNECTION_STATE_LABELS[state]}${
          attempt
            ? ` (${attempt} failed attempt${attempt === 1 ? "" : "s"})`
            : ""
        }`,
    )
    .join("\n");

/**
 * Global connection status: a dot and label (Connected / Connecting… /
 * Reconnecting… / Disconnected / Connection failed) for the worst of the
 * observed Vuu connections, with the next retry countdown when known and a
 * "Retry now" button. Mount once in a header (docs/resilience.md).
 *
 * For standalone apps (e.g. the showcase). Inside the portal, the nav footer's
 * `PortalConnectionStatus` (@vuu-ui/core/portal) shows connection status.
 */
export const ConnectionStatusIndicator = forwardRef<
  HTMLSpanElement,
  ConnectionStatusIndicatorProps
>(function ConnectionStatusIndicator(
  {
    className,
    compact = false,
    connectionIds,
    labels,
    showRetry = true,
    state: stateProp,
    title,
    ...htmlAttributes
  },
  ref,
) {
  const targetWindow = useWindow();
  useComponentCssInjection({
    testId: "trading-connection-status-indicator",
    css: connectionStatusIndicatorCss,
    window: targetWindow,
  });
  const { state: observed, statuses } = useVuuConnectionStatuses(connectionIds);
  const state = stateProp ?? observed;
  const affected = statuses.filter((status) => status.state === state);
  const nextAttemptAt = Math.min(
    ...affected.map(
      ({ nextAttemptAt }) => nextAttemptAt ?? Number.POSITIVE_INFINITY,
    ),
  );
  const now = useNow(Number.isFinite(nextAttemptAt));
  const retries = affected.flatMap(({ retry }) => (retry ? [retry] : []));
  const label = labels?.[state] ?? CONNECTION_STATE_LABELS[state];
  const countdown =
    state === "reconnecting" && Number.isFinite(nextAttemptAt)
      ? Math.max(0, Math.ceil((nextAttemptAt - now) / 1_000))
      : undefined;

  return (
    // biome-ignore lint/a11y/useSemanticElements: live connection status
    <span
      {...htmlAttributes}
      aria-label={`Connection status: ${CONNECTION_STATE_LABELS[state]}`}
      className={cx(classBase, className)}
      data-connection-state={state}
      ref={ref}
      role="status"
      title={title ?? (describe(statuses) || undefined)}
    >
      <span aria-hidden className={`${classBase}-dot`} />
      {compact && state === "connected" ? null : (
        <span className={`${classBase}-label`}>
          {label}
          {countdown !== undefined ? ` retrying in ${countdown}s` : null}
        </span>
      )}
      {showRetry && stateProp === undefined && retries.length > 0 ? (
        <Button
          appearance="transparent"
          className={`${classBase}-retry`}
          onClick={() => {
            for (const retry of retries) retry();
          }}
          sentiment="neutral"
        >
          Retry now
        </Button>
      ) : null}
    </span>
  );
});
