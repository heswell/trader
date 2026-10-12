import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import { ConnectionBanner } from "../components/ConnectionBanner";
import { OrderTicketLauncherProvider } from "../components/OrderTicket";
import { connectBroadcastChannel } from "../instrument-context/broadcastChannelTransport";
import { getInstrumentLinkBus } from "../instrument-context/instrumentLinkBus";
import {
  TradingNotificationsProvider,
  type TradingNotificationsProviderProps,
} from "../notifications/TradingNotificationsProvider";
import { notificationLease } from "./notificationLease";

const FeatureRootContext = createContext(false);

/** True inside a TradingFeatureRoot. */
export const useInTradingFeatureRoot = () => useContext(FeatureRootContext);

const BROADCAST_KEY = Symbol.for("@heswell/trading-ui/link-bus-broadcast");

/**
 * Link the window's instrument link bus with other windows (popouts, other
 * tabs) over BroadcastChannel, once per window however many features call it.
 */
export const ensureLinkBusBroadcast = () => {
  const g = globalThis as unknown as Record<symbol, (() => void) | undefined>;
  if (!g[BROADCAST_KEY]) {
    g[BROADCAST_KEY] = connectBroadcastChannel(getInstrumentLinkBus());
  }
};

/** True while this caller holds the window's notification lease. */
const useNotificationLease = (enabled: boolean) => {
  const [token] = useState(() => Symbol("trading-feature-root"));
  useEffect(
    () => (enabled ? notificationLease.acquire(token) : undefined),
    [enabled, token],
  );
  const holder = useSyncExternalStore(
    notificationLease.subscribe,
    notificationLease.holder,
    notificationLease.holder,
  );
  return enabled && holder === token;
};

export interface TradingFeatureRootProps
  extends Pick<TradingNotificationsProviderProps, "scope" | "kinds"> {
  children: ReactNode;
  /** Render the ConnectionBanner (default true). */
  connectionBanner?: boolean;
  /** Stream order notifications if no other root in the window does (default true). */
  notifications?: boolean;
}

/**
 * What every trading MF feature wraps its content in. It mounts the
 * per-host services once:
 *
 * - Nested in another TradingFeatureRoot (a composite feature rendering
 *   child modules): renders children only.
 * - Otherwise: TradingNotificationsProvider (with InstrumentLookupProvider),
 *   OrderTicketLauncherProvider and ConnectionBanner. Only one root per
 *   window streams order notifications (window-global lease), so several
 *   features open in one portal do not toast each event twice.
 * - Always: the window link bus is connected to BroadcastChannel once, so
 *   popped-out features stay linked.
 *
 * The vuu NotificationsProvider (toast centre) is the host's: vuu-portal
 * mounts it. Data comes from the enclosing DataProvider (mode "inherit").
 */
export const TradingFeatureRoot = ({
  children,
  connectionBanner = true,
  kinds,
  notifications = true,
  scope,
}: TradingFeatureRootProps) => {
  const nested = useContext(FeatureRootContext);
  const streaming = useNotificationLease(notifications && !nested);
  useEffect(ensureLinkBusBroadcast, []);
  if (nested) return <>{children}</>;
  return (
    <FeatureRootContext.Provider value>
      <TradingNotificationsProvider
        kinds={kinds}
        scope={scope}
        streams={streaming}
      >
        <OrderTicketLauncherProvider>
          {connectionBanner ? <ConnectionBanner /> : null}
          {children}
        </OrderTicketLauncherProvider>
      </TradingNotificationsProvider>
    </FeatureRootContext.Provider>
  );
};
