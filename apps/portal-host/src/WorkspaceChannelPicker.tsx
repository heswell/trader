import {
  ChannelPicker,
  type LinkGroupId,
  WorkspaceChannelProvider,
} from "@heswell/trading-ui";
import { AuthenticationProvider } from "@vuu-ui/core";
import { type ReactNode, useCallback, useState } from "react";
import { useTradingServer } from "./nav/TradingNavFeed";

const ACTIVE_CHANNEL_KEY = "activeChannel";

const readActiveChannel = (storageKey: string): LinkGroupId | undefined => {
  try {
    return localStorage.getItem(storageKey) ?? undefined;
  } catch {
    return undefined;
  }
};

/**
 * The workspace channel for the whole portal: the ChannelPicker in the
 * workspace header sets it, and panels in the `active` link group follow
 * it. Kept in this browser (per portal) so a reload keeps the channel.
 */
export const PortalWorkspaceChannel = ({
  children,
  portalId,
}: {
  children: ReactNode;
  portalId: string;
}) => {
  const storageKey = `${portalId}.${ACTIVE_CHANNEL_KEY}`;
  const [defaultActiveChannel] = useState(() => readActiveChannel(storageKey));
  const saveActiveChannel = useCallback(
    (channel: LinkGroupId) => {
      try {
        localStorage.setItem(storageKey, channel);
      } catch {
        // storage unavailable (private window): keep it for this session only
      }
    },
    [storageKey],
  );
  return (
    <WorkspaceChannelProvider
      defaultActiveChannel={defaultActiveChannel}
      onActiveChannelChange={saveActiveChannel}
    >
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
