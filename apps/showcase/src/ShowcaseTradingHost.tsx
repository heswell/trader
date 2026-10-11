import {
  ConnectionBanner,
  OrderTicketLauncherProvider,
  TradingNotificationsProvider,
} from "@heswell/trading-ui";
import type { ReactNode } from "react";
import { SHOWCASE_USER } from "./useShowcaseDataMode";

/**
 * What a host (e.g. vuu-portal) mounts once, inside TradingDataProvider and
 * InstrumentContextProvider: order notifications (toasts), the order ticket
 * launcher and the connection banner.
 */
export const ShowcaseTradingHost = ({ children }: { children: ReactNode }) => (
  <TradingNotificationsProvider notificationsCenter trader={SHOWCASE_USER}>
    <OrderTicketLauncherProvider>
      <ConnectionBanner />
      {children}
    </OrderTicketLauncherProvider>
  </TradingNotificationsProvider>
);
