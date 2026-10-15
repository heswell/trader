import {
  FillsBlotterExample,
  OrderBlotterExample,
  PositionsViewExample,
  TradeTapeExample,
} from "./BlotterExamples";
import {
  InstrumentGridExamples,
  InstrumentGridPrices,
  InstrumentGridTicking200,
} from "./InstrumentGridExamples";
import {
  ConnectionOverrideExample,
  FeatureRootExample,
  UserSettingsExample,
} from "./HostingExamples";
import { InstrumentPricesTicking } from "./InstrumentPricesTicking";
import { LinkingProvidersExample, SelectorsExample } from "./LinkingExamples";
import { MarketDepthExamples } from "./MarketDepthExamples";
import { PriceLadderLive, PriceLadderStress } from "./PriceLadderExamples";
import {
  ConnectionStateExample,
  NotificationSettingsExample,
} from "./NotificationsExamples";
import {
  OrderTicketCompact,
  OrderTicketDialogExample,
  OrderTicketDocked,
  OrderTicketLauncherExample,
} from "./OrderTicketExamples";
import {
  CellRenderersExample,
  StatusPrimitivesExample,
} from "./PrimitivesExamples";
import { SideLabelExamples } from "./SideLabelExamples";
import { TraderWorkspace } from "./TraderWorkspaceExamples";
import type { ShowcaseExample } from "./types";

export type { ShowcaseExample } from "./types";

/**
 * The showcase example registry. To add an example: create
 * `examples/<Component>Examples.tsx` exporting a component, then add an entry
 * here (keep groups together, ids unique).
 */
export const examples: ShowcaseExample[] = [
  {
    id: "trader-workspace",
    group: "Workspace",
    title: "Trader workspace (linked)",
    description:
      "vuu-layout workspace with two instrument link groups: red follows the grid (ticket, depth, orders, fills), green follows the picker and positions (ladder, tape). Change a View's group with its swatch; the choice is saved with the layout.",
    Component: TraderWorkspace,
  },
  {
    id: "stack-instrument-prices",
    group: "Stack",
    title: "Ticking prices + createOrder",
    description:
      "instrumentPrices with the vuu.price-move-background renderer; buy/sell the selected instrument and watch the parentOrders row.",
    Component: InstrumentPricesTicking,
  },
  {
    id: "instrument-grid",
    group: "InstrumentGrid",
    title: "Instrument grid",
    description:
      "instrumentPrices with price-move, change, phase, sparkline; watchlists, grouping, column picker, quick filter, context menu (Buy/Sell/Depth callbacks).",
    Component: InstrumentGridExamples,
  },
  {
    id: "instrument-grid-prices",
    group: "InstrumentGrid",
    title: "Prices only",
    description:
      "Bound to the prices table: no static data, graceful fallback.",
    Component: InstrumentGridPrices,
  },
  {
    id: "instrument-grid-200",
    group: "InstrumentGrid",
    title: "200 ticking rows (perf)",
    description:
      "Open with ?active=200 (local mode) to tick 200 instruments with sparklines.",
    Component: InstrumentGridTicking200,
  },
  {
    id: "side-label-variants",
    group: "SideLabel",
    title: "Variants",
    Component: SideLabelExamples,
  },
  {
    id: "order-blotter",
    group: "OrderBlotter",
    title: "Working / filled / closed with amend and cancel",
    Component: OrderBlotterExample,
  },
  {
    id: "fills-blotter",
    group: "FillsBlotter",
    title: "Fills with grouping, VWAP and CSV export",
    Component: FillsBlotterExample,
  },
  {
    id: "trade-tape",
    group: "TradeTape",
    title: "Time & sales for the selected order's instrument",
    Component: TradeTapeExample,
  },
  {
    id: "positions-view",
    group: "PositionsView",
    title: "Ticking P&L with per-currency totals",
    Component: PositionsViewExample,
  },
  {
    id: "market-depth-selected",
    group: "MarketDepth",
    title: "Selected instrument",
    description:
      "Aggregated depth following the selected instrument: own orders (ACC-US-01), flashes, depth bars, halt / resume, and a second depth pinned to a ric.",
    Component: MarketDepthExamples,
  },
  {
    id: "price-ladder-live",
    group: "PriceLadder",
    title: "Live ladder",
    description:
      "Click bid / ask to trade (ACC-US-01), drag or M+arrows+Enter to amend, Delete / double-click to cancel, C to centre.",
    Component: PriceLadderLive,
  },
  {
    id: "price-ladder-stress",
    group: "PriceLadder",
    title: "Stress (50+ updates/s)",
    description:
      "PriceLadderView with a synthetic book at 10-200 updates/s; React Profiler and rAF FPS stats.",
    Component: PriceLadderStress,
  },
  {
    id: "order-ticket-docked",
    group: "OrderTicket",
    title: "Docked panel + prefill",
    description:
      "Instrument picker, live quote, lot/tick validation, risk preview. Prefill buttons call useOrderTicketLauncher().openOrderTicket(), routed to the docked ticket.",
    Component: OrderTicketDocked,
  },
  {
    id: "order-ticket-dialog",
    group: "OrderTicket",
    title: "Dialog",
    Component: OrderTicketDialogExample,
  },
  {
    id: "order-ticket-compact",
    group: "OrderTicket",
    title: "Compact inline",
    Component: OrderTicketCompact,
  },
  {
    id: "order-ticket-launcher",
    group: "OrderTicket",
    title: "Launcher (dialog fallback)",
    description:
      "openOrderTicket({ ric, side }) with no docked ticket opens the dialog.",
    Component: OrderTicketLauncherExample,
  },
  {
    id: "notifications-settings",
    group: "Notifications",
    title: "Order toasts",
    description:
      "TradingNotificationsProvider toasts acks, rejects and fills from the parentOrders / fills streams (deduped, rate limited).",
    Component: NotificationSettingsExample,
  },
  {
    id: "notifications-connection",
    group: "Notifications",
    title: "Connection banner + stale",
    Component: ConnectionStateExample,
  },
  {
    id: "linking-providers",
    group: "Linking",
    title: "Link groups and providers",
    description:
      "InstrumentContextProvider (private bus), LinkGroupProvider subtrees and useSelectedInstrument.",
    Component: LinkingProvidersExample,
  },
  {
    id: "selectors",
    group: "Selectors",
    title: "Account, link group and lookup",
    description:
      "AccountSelector + useSelectedAccount, LinkGroupSelector, InstrumentLookupProvider + useInstrumentLookup.",
    Component: SelectorsExample,
  },
  {
    id: "primitives-status",
    group: "Primitives",
    title: "Status, progress, P&L, sparkline",
    description: "OrderStatusBadge, FillProgressBar, PnlValue and Sparkline.",
    Component: StatusPrimitivesExample,
  },
  {
    id: "primitives-cell-renderers",
    group: "Primitives",
    title: "Cell renderers in a vuu Table",
    description:
      "trading.price-move, trading.change, trading.quantity, trading.phase and trading.sparkline, by name in a TableConfig.",
    Component: CellRenderersExample,
  },
  {
    id: "hosting-feature-root",
    group: "Hosting",
    title: "TradingFeatureRoot",
    description:
      "The root an MF feature renders (banner + notifications); nested roots render children only.",
    Component: FeatureRootExample,
  },
  {
    id: "hosting-connection-override",
    group: "Hosting",
    title: "Connection state override",
    description:
      "TradingConnectionStateOverride forces a connection state below it, e.g. to see a ticket disable while reconnecting.",
    Component: ConnectionOverrideExample,
  },
  {
    id: "hosting-user-settings",
    group: "Hosting",
    title: "User settings storage",
    description:
      "UserSettingsProvider with in-memory storage: InstrumentGrid watchlists are written to it.",
    Component: UserSettingsExample,
  },
];
