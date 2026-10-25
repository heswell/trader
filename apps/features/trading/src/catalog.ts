/**
 * The trading features: one module-federation remote per feature (the
 * portal requires a unique mfScope per registered module), all built from
 * this package's source. scripts/features/build.ts builds them into
 * dist/<key>/ and scripts/features/sync-build-config.ts generates
 * apps/portal-config/default-modules.yaml from this list.
 *
 * Nav: a module's `location` is "/<Section>/<Entry>". PortalNav sorts entries
 * by `navOrder` and sections by their lowest entry's navOrder, so each
 * section owns a hundreds band (Trading 100s, Market 200s, Portfolio 300s,
 * Oversight 400s). Workspaces (incl. the Trader system workspace,
 * apps/portal-host/src/workspaces) are the portal's own nav section.
 *
 * Panels palette: modules with `workspace` can be added as workspace panels.
 * Not in the palette: the Desk overview (a supervisor's desk-wide, tabbed
 * console of every desk's orders and positions: a page, not a panel).
 */
import type { TradingNavIcon } from "./navIcons";

/**
 * Trading server roles: client roles of the trading Vuu server's own Keycloak
 * client (trader-trading-server). The OMS enforces them on every viewport and
 * RPC; the UI reads them from the trading connection (useVuuAuthorizations).
 */
export type TradingRole =
  | "trading-view"
  | "trading-execute"
  | "trading-supervisor";

/**
 * Navigation roles: `vuu-portal` client roles, the modules' `accessRole`. The
 * portal server lists a module only for users holding it. Each trading role
 * has one; users are granted both (scripts/stack/keycloak-realm.ts).
 */
export type TradingAccessRole =
  | "trading-access"
  | "trading-execute-access"
  | "trading-supervisor-access";

export const TRADING_ACCESS_ROLE: Readonly<
  Record<TradingRole, TradingAccessRole>
> = {
  "trading-view": "trading-access",
  "trading-execute": "trading-execute-access",
  "trading-supervisor": "trading-supervisor-access",
};

export interface TradingFeature {
  /** Build / URL key: served at <featuresOrigin>/<key>/. */
  key: string;
  /** Portal module id (stable: user saved state is not keyed by it). */
  id: number;
  /** Portal module name (unique). Child modules are looked up by it. */
  name: string;
  /** Module-federation container name = portal mfScope (unique). */
  mfScope: string;
  /** Exposed module = portal mfComponent. */
  expose: string;
  source: string;
  title: string;
  description: string;
  accessRole: TradingAccessRole;
  /** Top-level modules: nav location ("/<Section>/<Entry>") and route. */
  location?: string;
  path?: string;
  /** Top-level modules: nav sort key (sections sort by their lowest). */
  navOrder?: number;
  /** Top-level modules: nav icon (navIcons.ts, emitted as navIconUrl). */
  navIcon?: TradingNavIcon;
  /** Key of a live nav badge the host renders (TradingNavBadgeKey). */
  navBadge?: TradingNavBadgeKey;
  /**
   * Notification topics this module claims on the trading connection: the
   * portal routes NOTIFICATIONS rows with a matching `topic` to it (nav dot,
   * mark-read when opened). Unclaimed topics go to the bell only.
   */
  notificationTopics?: readonly TradingNotificationTopic[];
  /** Child modules: the parent's key (rendered by the parent, no nav entry). */
  parent?: string;
  /**
   * Panels palette entry (the portal's `VuuModuleDescriptor.workspace`):
   * only modules with it can be added to a portal workspace. The palette
   * icon defaults to the nav icon; `defaultSize` (grid tracks) only orients
   * the split of a new panel (wider: below the target, taller: beside it).
   */
  workspace?: TradingModuleWorkspace;
}

/** Panels palette groups (match the nav sections). */
export const TRADING_PALETTE_GROUP = {
  trading: "Trading",
  market: "Market",
  portfolio: "Portfolio",
} as const;

export interface TradingModuleWorkspace {
  paletteGroup: (typeof TRADING_PALETTE_GROUP)[keyof typeof TRADING_PALETTE_GROUP];
  /** Palette icon (data URL), when it differs from the nav icon. */
  iconUrl?: string;
  defaultSize?: { cols?: number; rows?: number };
}

/** Live nav badges, rendered by the portal host (apps/portal-host). */
export type TradingNavBadgeKey = "orders.working" | "positions.dayPnl";

/** `topic` values the trading server writes to its NOTIFICATIONS table. */
export type TradingNotificationTopic =
  | "orders"
  | "fills"
  | "marketdata"
  | "positions"
  | "risk";

const view = TRADING_ACCESS_ROLE["trading-view"];
const execute = TRADING_ACCESS_ROLE["trading-execute"];
const TRADING = TRADING_PALETTE_GROUP.trading;
const MARKET = TRADING_PALETTE_GROUP.market;
const PORTFOLIO = TRADING_PALETTE_GROUP.portfolio;

export const TRADING_FEATURES: readonly TradingFeature[] = [
  {
    key: "watchlist",
    id: 110,
    name: "TradingWatchlist",
    mfScope: "tradingWatchlist",
    expose: "./Watchlist",
    source: "./src/features/Watchlist",
    title: "Watchlist",
    description: "Ticking instrument grid with sparklines and watchlists",
    accessRole: view,
    location: "/Trading/Watchlist",
    path: "/trading/watchlist",
    navOrder: 100,
    navIcon: "watchlist",
    notificationTopics: ["marketdata"],
    workspace: { paletteGroup: TRADING, defaultSize: { cols: 2, rows: 1 } },
  },
  {
    key: "orders",
    id: 114,
    name: "TradingOrders",
    mfScope: "tradingOrders",
    expose: "./Orders",
    source: "./src/features/Orders",
    title: "Orders",
    description: "Order blotter: working, filled, closed",
    accessRole: view,
    location: "/Trading/Orders",
    path: "/trading/orders",
    navOrder: 110,
    navIcon: "orders",
    navBadge: "orders.working",
    notificationTopics: ["orders"],
    workspace: { paletteGroup: TRADING, defaultSize: { cols: 2, rows: 1 } },
  },
  {
    key: "fills",
    id: 115,
    name: "TradingFills",
    mfScope: "tradingFills",
    expose: "./Fills",
    source: "./src/features/Fills",
    title: "Executions",
    description: "Executions (fills) blotter",
    accessRole: view,
    location: "/Trading/Executions",
    path: "/trading/executions",
    navOrder: 120,
    navIcon: "executions",
    notificationTopics: ["fills"],
    workspace: { paletteGroup: TRADING, defaultSize: { cols: 2, rows: 1 } },
  },
  {
    key: "ladder",
    id: 112,
    name: "TradingLadder",
    mfScope: "tradingLadder",
    expose: "./Ladder",
    source: "./src/features/Ladder",
    title: "Price ladder",
    description: "Click-to-trade price ladder",
    accessRole: execute,
    location: "/Trading/Price ladder",
    path: "/trading/price-ladder",
    navOrder: 130,
    navIcon: "ladder",
    notificationTopics: ["orders"],
    workspace: { paletteGroup: TRADING, defaultSize: { cols: 1, rows: 2 } },
  },
  {
    key: "ticket",
    id: 124,
    name: "TradingTicket",
    mfScope: "tradingTicket",
    expose: "./Ticket",
    source: "./src/features/Ticket",
    title: "Order ticket",
    description:
      "Order entry for the linked instrument; the launch target for Buy / Sell in the same window",
    accessRole: execute,
    location: "/Trading/Order ticket",
    path: "/trading/ticket",
    navOrder: 140,
    navIcon: "ticket",
    notificationTopics: ["orders"],
    workspace: { paletteGroup: TRADING, defaultSize: { cols: 1, rows: 2 } },
  },
  {
    key: "depth",
    id: 111,
    name: "TradingDepth",
    mfScope: "tradingDepth",
    expose: "./Depth",
    source: "./src/features/Depth",
    title: "Market depth",
    description: "Order book depth for the linked instrument",
    accessRole: view,
    location: "/Market/Market depth",
    path: "/market/depth",
    navOrder: 200,
    navIcon: "depth",
    notificationTopics: ["marketdata"],
    workspace: { paletteGroup: MARKET, defaultSize: { cols: 1, rows: 2 } },
  },
  {
    key: "tape",
    id: 117,
    name: "TradingTape",
    mfScope: "tradingTape",
    expose: "./Tape",
    source: "./src/features/Tape",
    title: "Time & sales",
    description: "Time and sales (trade tape) for the linked instrument",
    accessRole: view,
    location: "/Market/Time & sales",
    path: "/market/time-and-sales",
    navOrder: 210,
    navIcon: "tape",
    notificationTopics: ["marketdata"],
    workspace: { paletteGroup: MARKET, defaultSize: { cols: 1, rows: 2 } },
  },
  {
    key: "chart",
    id: 118,
    name: "TradingChart",
    mfScope: "tradingChart",
    expose: "./Chart",
    source: "./src/features/Chart",
    title: "Chart",
    description:
      "Candlestick price chart (1s / 1m / 5m bars) for the linked instrument with VWAP and the account's fills",
    accessRole: view,
    location: "/Market/Chart",
    path: "/market/chart",
    navOrder: 220,
    navIcon: "chart",
    workspace: { paletteGroup: MARKET, defaultSize: { cols: 2, rows: 1 } },
  },
  {
    key: "depth-chart",
    id: 119,
    name: "TradingDepthChart",
    mfScope: "tradingDepthChart",
    expose: "./DepthChart",
    source: "./src/features/DepthChart",
    title: "Depth chart",
    description: "Live cumulative depth chart for the linked instrument",
    accessRole: view,
    location: "/Market/Depth chart",
    path: "/market/depth-chart",
    navOrder: 230,
    navIcon: "depth-chart",
    workspace: { paletteGroup: MARKET, defaultSize: { cols: 2, rows: 1 } },
  },
  {
    key: "positions",
    id: 116,
    name: "TradingPositions",
    mfScope: "tradingPositions",
    expose: "./Positions",
    source: "./src/features/Positions",
    title: "Positions",
    description: "Positions and P&L by account / instrument",
    accessRole: view,
    location: "/Portfolio/Positions",
    path: "/portfolio/positions",
    navOrder: 300,
    navIcon: "positions",
    navBadge: "positions.dayPnl",
    notificationTopics: ["positions", "risk"],
    workspace: { paletteGroup: PORTFOLIO, defaultSize: { cols: 2, rows: 1 } },
  },
  {
    key: "pnl",
    id: 121,
    name: "TradingPnl",
    mfScope: "tradingPnl",
    expose: "./Pnl",
    source: "./src/features/Pnl",
    title: "P&L",
    description: "Account P&L history (realised / unrealised)",
    accessRole: view,
    location: "/Portfolio/P&L",
    path: "/portfolio/pnl",
    navOrder: 310,
    navIcon: "pnl",
    workspace: { paletteGroup: PORTFOLIO, defaultSize: { cols: 2, rows: 1 } },
  },
  {
    key: "exposure",
    id: 122,
    name: "TradingExposure",
    mfScope: "tradingExposure",
    expose: "./Exposure",
    source: "./src/features/Exposure",
    title: "Exposure",
    description: "Account exposure / P&L treemap by sector",
    accessRole: view,
    location: "/Portfolio/Exposure",
    path: "/portfolio/exposure",
    navOrder: 320,
    navIcon: "exposure",
    notificationTopics: ["risk"],
    workspace: { paletteGroup: PORTFOLIO, defaultSize: { cols: 2, rows: 1 } },
  },
  {
    key: "execution-quality",
    id: 123,
    name: "TradingExecutionQuality",
    mfScope: "tradingExecutionQuality",
    expose: "./ExecutionQuality",
    source: "./src/features/ExecutionQuality",
    title: "Execution quality",
    description: "Account execution slippage vs arrival price",
    accessRole: view,
    location: "/Portfolio/Execution quality",
    path: "/portfolio/execution-quality",
    navOrder: 330,
    navIcon: "execution-quality",
    workspace: { paletteGroup: PORTFOLIO, defaultSize: { cols: 2, rows: 1 } },
  },
  {
    key: "supervisor",
    id: 120,
    name: "TradingSupervisor",
    mfScope: "tradingSupervisor",
    expose: "./Supervisor",
    source: "./src/features/Supervisor",
    title: "Desk overview",
    description:
      "All desks' orders (incl. child orders) and positions by account",
    accessRole: TRADING_ACCESS_ROLE["trading-supervisor"],
    location: "/Oversight/Desk overview",
    path: "/oversight/desk",
    navOrder: 400,
    navIcon: "oversight",
    notificationTopics: ["risk", "orders"],
    // Not in the Panels palette: a page-sized, desk-wide composite (two
    // blotters over every account) that follows no link group, so it gains
    // nothing beside instrument panels and is cramped as one.
  },
];
