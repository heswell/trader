/**
 * The trading features: one module-federation remote per feature (the
 * portal requires a unique mfScope per registered module), all built from
 * this package's source. scripts/features/build.ts builds them into
 * dist/<key>/ and scripts/features/sync-build-config.ts generates
 * apps/portal-config/default-modules.yaml from this list.
 */
export type TradingRole =
  | "trading-view"
  | "trading-execute"
  | "trading-supervisor";

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
  accessRole: TradingRole;
  /** Top-level modules: nav location and route. */
  location?: string;
  path?: string;
  /** Child modules: the parent's key (rendered by the parent, no nav entry). */
  parent?: string;
}

const view: TradingRole = "trading-view";
const execute: TradingRole = "trading-execute";

export const TRADING_FEATURES: readonly TradingFeature[] = [
  {
    key: "workspace",
    id: 100,
    name: "TradingWorkspace",
    mfScope: "tradingWorkspace",
    expose: "./TraderWorkspace",
    source: "./src/features/TraderWorkspace",
    title: "Trader workspace",
    description:
      "Prebuilt trader layout: watchlist, depth, ticket, ladder, blotters, positions and tape with red / green link groups",
    accessRole: view,
    location: "/Trading/Workspace",
    path: "/trading/workspace",
  },
  {
    key: "workspace-ticket",
    id: 101,
    name: "TradingWorkspaceTicket",
    mfScope: "tradingWorkspaceTicket",
    expose: "./Ticket",
    source: "./src/features/Ticket",
    title: "Workspace order ticket",
    description: "Order ticket docked in the trader workspace",
    accessRole: execute,
    parent: "workspace",
  },
  {
    key: "workspace-ladder",
    id: 102,
    name: "TradingWorkspaceLadder",
    mfScope: "tradingWorkspaceLadder",
    expose: "./Ladder",
    source: "./src/features/Ladder",
    title: "Workspace price ladder",
    description: "Price ladder docked in the trader workspace",
    accessRole: execute,
    parent: "workspace",
  },
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
    location: "/Trading/Depth",
    path: "/trading/depth",
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
    location: "/Trading/Ladder",
    path: "/trading/ladder",
  },
  {
    key: "ticket",
    id: 113,
    name: "TradingTicket",
    mfScope: "tradingTicket",
    expose: "./Ticket",
    source: "./src/features/Ticket",
    title: "Order ticket",
    description: "Docked order ticket following its link group",
    accessRole: execute,
    location: "/Trading/Ticket",
    path: "/trading/ticket",
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
  },
  {
    key: "fills",
    id: 115,
    name: "TradingFills",
    mfScope: "tradingFills",
    expose: "./Fills",
    source: "./src/features/Fills",
    title: "Fills",
    description: "Executions blotter",
    accessRole: view,
    location: "/Trading/Fills",
    path: "/trading/fills",
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
    location: "/Trading/Positions",
    path: "/trading/positions",
  },
  {
    key: "tape",
    id: 117,
    name: "TradingTape",
    mfScope: "tradingTape",
    expose: "./Tape",
    source: "./src/features/Tape",
    title: "Trade tape",
    description: "Time and sales for the linked instrument",
    accessRole: view,
    location: "/Trading/Tape",
    path: "/trading/tape",
  },
  {
    key: "supervisor",
    id: 120,
    name: "TradingSupervisor",
    mfScope: "tradingSupervisor",
    expose: "./Supervisor",
    source: "./src/features/Supervisor",
    title: "Supervisor",
    description:
      "All desks' orders (incl. child orders) and positions by account",
    accessRole: "trading-supervisor",
    location: "/Supervision/Desk overview",
    path: "/supervision/desk",
  },
];
