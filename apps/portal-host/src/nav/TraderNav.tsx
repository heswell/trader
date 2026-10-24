import {
  type RemoteModuleDescriptor,
  usePortalVuuAuthTarget,
} from "@vuu-ui/core";
import {
  NotificationsIndicator,
  type PortalConnectionDescriptor,
  PortalConnectionStatus,
  PortalNav,
  type PortalNavDisplayMode,
  type PortalNavItem,
  type PortalNavSlotContext,
  PortalNavUserMenu,
  PortalNavUserMenuItem,
} from "@vuu-ui/core/portal";
import { VuuLogo } from "@vuu-ui/vuu-icons";
import { useCallback, useMemo, useState } from "react";
import {
  TRADING_CONNECTION_ID,
  TradingNavFeed,
  type TradingNavFeedValues,
  useTradingServer,
} from "./TradingNavFeed";
import { renderTradingNavBadge } from "./tradingNavBadges";

export const PORTAL_CONNECTION_ID = "portal";

export const TRADER_NAV_DISPLAY_MODES: readonly PortalNavDisplayMode[] = [
  "icons-and-text",
  "text",
  "icons",
  "minimized",
];

export const TRADER_NAV_DISPLAY_MODE_LABELS: Record<
  PortalNavDisplayMode,
  string
> = {
  "icons-and-text": "Icons and text",
  text: "Text only",
  icons: "Icons only",
  minimized: "Hidden",
};

/**
 * User menu items choosing the nav display mode (⌘B / Ctrl+B only toggles
 * between the expanded mode and `collapseTo`).
 */
const DisplayModeItems = ({
  allowedDisplayModes,
  displayMode,
  setDisplayMode,
}: PortalNavSlotContext) =>
  allowedDisplayModes.map((mode) => (
    <PortalNavUserMenuItem
      aria-current={mode === displayMode || undefined}
      className="traderNavDisplayMode"
      endAdornment={mode === displayMode ? "✓" : undefined}
      key={mode}
      onClick={() => setDisplayMode(mode)}
    >
      {TRADER_NAV_DISPLAY_MODE_LABELS[mode]}
    </PortalNavUserMenuItem>
  ));

/**
 * Friendly labels and impact for the footer's connection status: the
 * portal's own connection and the trading server's (see findTradingServer).
 */
export const traderConnections = (
  portalConnectionId = PORTAL_CONNECTION_ID,
  tradingConnectionId = TRADING_CONNECTION_ID,
): PortalConnectionDescriptor[] => [
  {
    connectionId: portalConnectionId,
    label: "Portal",
    impact:
      "Trading unaffected; layout and settings changes are kept locally until it reconnects",
  },
  {
    connectionId: tradingConnectionId,
    label: "Trading",
    impact: "Market data is stale and order entry is blocked",
  },
];

export interface TraderNavProps {
  /** Shown as a chip next to the product name, e.g. "UAT". */
  environment?: string;
  remoteModules: RemoteModuleDescriptor[];
}

const Brand = ({
  displayMode,
  environment,
  setDisplayMode,
}: PortalNavSlotContext & { environment?: string }) =>
  displayMode === "icons" ? (
    <>
      <button
        aria-label="Expand navigation"
        className="traderNavBrand-logo traderNavBrand-logoButton"
        onClick={() => setDisplayMode("icons-and-text")}
        title="Expand navigation"
        type="button"
      >
        <VuuLogo />
      </button>
      <NotificationsIndicator compactStyle="bell" scope="unclaimed" />
    </>
  ) : (
    <>
      <span className="traderNavBrand-logo">
        <VuuLogo />
      </span>
      <span className="traderNavBrand-name">Trader</span>
      {environment ? (
        <span className="traderNavBrand-env">{environment}</span>
      ) : null}
      <NotificationsIndicator
        className="traderNavBrand-bell"
        compactStyle="bell"
        scope="unclaimed"
      />
    </>
  );

/**
 * The trader portal nav: PortalNav with the Trader brand and bell, live
 * badges (working orders, P&L), and connection status and user menu in the
 * footer.
 */
export const TraderNav = ({ environment, remoteModules }: TraderNavProps) => {
  const [feed, setFeed] = useState<TradingNavFeedValues>({ badges: {} });
  const onFeedChange = useCallback(
    (values: TradingNavFeedValues) => setFeed(values),
    [],
  );
  const { account, badges } = feed;
  const portalConnectionId =
    usePortalVuuAuthTarget().connectionId ?? PORTAL_CONNECTION_ID;
  const tradingConnectionId =
    useTradingServer()?.connectionId ?? TRADING_CONNECTION_ID;
  const connections = useMemo(
    () => traderConnections(portalConnectionId, tradingConnectionId),
    [portalConnectionId, tradingConnectionId],
  );

  const renderBadge = useCallback(
    (item: PortalNavItem) => renderTradingNavBadge(item.navBadge, badges),
    [badges],
  );
  const brand = useCallback(
    (context: PortalNavSlotContext) => (
      <Brand {...context} environment={environment} />
    ),
    [environment],
  );
  const footer = useMemo(
    () => (context: PortalNavSlotContext) => {
      const variant = context.displayMode === "icons" ? "rail" : "expanded";
      return (
        <>
          <PortalConnectionStatus connections={connections} variant={variant} />
          <PortalNavUserMenu account={account} variant={variant}>
            <DisplayModeItems {...context} />
          </PortalNavUserMenu>
        </>
      );
    },
    [account, connections],
  );

  return (
    <>
      <PortalNav
        allowedDisplayModes={TRADER_NAV_DISPLAY_MODES}
        brand={brand}
        className="traderNav"
        collapseTo="icons"
        defaultDisplayMode="icons-and-text"
        footer={footer}
        remoteModules={remoteModules}
        renderBadge={renderBadge}
        sections="headings"
      />
      <TradingNavFeed onChange={onFeedChange} />
    </>
  );
};
