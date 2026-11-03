import {
  ChannelPicker,
  type LinkGroupId,
  WorkspaceChannelProvider,
} from "@heswell/trading-ui";
import { AuthenticationProvider } from "@vuu-ui/core";
import { type ReactNode, useEffect, useState } from "react";
import { useTradingServer } from "./nav/TradingNavFeed";

const LEGACY_ACTIVE_CHANNEL_KEY = "activeChannel";

/**
 * The active channel saved by earlier versions straight in localStorage
 * (`<portalId>.activeChannel`). Read once as the initial channel and
 * removed: InstrumentLinkPersistence now saves it in the portal's state.
 */
const legacyKey = (portalId: string) =>
  `${portalId}.${LEGACY_ACTIVE_CHANNEL_KEY}`;

const readLegacyActiveChannel = (portalId: string): LinkGroupId | undefined => {
  try {
    return localStorage.getItem(legacyKey(portalId)) ?? undefined;
  } catch {
    return undefined;
  }
};

/**
 * The workspace channel for the whole portal: the ChannelPicker in the
 * workspace header sets it, and panels in the `active` link group follow
 * it. It wraps the PortalShell so the header and every workspace item see
 * it; InstrumentLinkPersistence (inside the shell, where the portal's
 * persistence service is) saves and restores it.
 */
export const PortalWorkspaceChannel = ({
  children,
  portalId,
}: {
  children: ReactNode;
  portalId: string;
}) => {
  const [defaultActiveChannel] = useState(() =>
    readLegacyActiveChannel(portalId),
  );
  useEffect(() => {
    try {
      localStorage.removeItem(legacyKey(portalId));
    } catch {
      // storage unavailable: nothing to remove
    }
  }, [portalId]);
  return (
    <WorkspaceChannelProvider defaultActiveChannel={defaultActiveChannel}>
      {children}
    </WorkspaceChannelProvider>
  );
};

/**
 * The ChannelPicker for the workspace header, on the trading server's
 * connection (as the nav badges are): it reads instruments and prices.
 * Renders nothing until the trading server is known.
 */
export const WorkspaceChannelPicker = () => {
  const connection = useTradingServer();
  if (!connection) return null;
  return (
    <AuthenticationProvider
      connection={connection}
      mode="vuu-connection"
      onError={(error) => console.warn("[WorkspaceChannelPicker]", error)}
    >
      <ChannelPicker />
    </AuthenticationProvider>
  );
};
