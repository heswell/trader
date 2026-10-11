import { Banner, BannerContent } from "@salt-ds/core";
import { useComponentCssInjection } from "@salt-ds/styles";
import { useWindow } from "@salt-ds/window";
import cx from "clsx";
import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import {
  type TradingConnectionState,
  useTradingConnectionStatus,
} from "../../connection/useTradingConnectionStatus";

import connectionBannerCss from "./ConnectionBanner.css";

const classBase = "tradingConnectionBanner";

export interface ConnectionBannerProps extends HTMLAttributes<HTMLDivElement> {
  /** Connection to observe (default: the trading data provider's). */
  connectionId?: string;
  /**
   * Show this state instead of observing the connection (host-managed
   * status, tests, showcase).
   */
  state?: TradingConnectionState;
  /** Banner text per state (overrides the defaults). */
  messages?: Partial<Record<TradingConnectionState, ReactNode>>;
}

const DEFAULT_MESSAGES: Record<
  Exclude<TradingConnectionState, "connected">,
  ReactNode
> = {
  connecting: "Connecting to the trading server…",
  reconnecting:
    "Connection lost, reconnecting… Prices and orders may be stale.",
  disconnected:
    "Disconnected from the trading server. Prices and orders are stale.",
  failed: "Unable to connect to the trading server.",
};

const bannerStatus = (state: TradingConnectionState) =>
  state === "failed" || state === "disconnected" ? "error" : "warning";

/**
 * A banner shown while the Vuu connection is not connected (connecting,
 * reconnecting, disconnected, failed). Renders nothing when connected.
 * Mount once near the top of a host layout.
 */
export const ConnectionBanner = forwardRef<
  HTMLDivElement,
  ConnectionBannerProps
>(function ConnectionBanner(
  { className, connectionId, messages, state: stateProp, ...htmlAttributes },
  ref,
) {
  const targetWindow = useWindow();
  useComponentCssInjection({
    testId: "trading-connection-banner",
    css: connectionBannerCss,
    window: targetWindow,
  });
  const { state: observed } = useTradingConnectionStatus(connectionId);
  const state = stateProp ?? observed;
  if (state === "connected") return null;
  return (
    <Banner
      {...htmlAttributes}
      className={cx(classBase, className)}
      data-connection-state={state}
      ref={ref}
      role="alert"
      status={bannerStatus(state)}
    >
      <BannerContent>
        {messages?.[state] ?? DEFAULT_MESSAGES[state]}
      </BannerContent>
    </Banner>
  );
});
