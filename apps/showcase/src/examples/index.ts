import {
  FillsBlotterExample,
  OrderBlotterExample,
  OrderBookViewExample,
  PositionsViewExample,
  TradeTapeExample,
} from "./BlotterExamples";
import {
  InstrumentGridContinuations,
  InstrumentGridExamples,
  InstrumentGridFutures,
  InstrumentGridPrices,
  InstrumentGridTicking200,
} from "./InstrumentGridExamples";
import {
  ConnectionOverrideExample,
  FeatureRootExample,
  UserSettingsExample,
} from "./HostingExamples";
import {
  ChartWorkspace,
  DepthChartExample,
  ExposureTreemapExample,
  PnlHistoryChartExample,
  PriceChartExample,
  SlippageChartExample,
  SpreadChartExample,
  TimeSeriesChartExample,
} from "./ChartExamples";
import {
  ChannelPickerFit,
  ChannelPickerWorkspace,
} from "./ChannelPickerExamples";
import { InstrumentPricesTicking } from "./InstrumentPricesTicking";
import {
  LinkingProvidersExample,
  PanelLinkGroupExample,
  SelectorsExample,
} from "./LinkingExamples";
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
import { ServerMetricsExample } from "./ServerMetricsExamples";
import { SideLabelExamples } from "./SideLabelExamples";
import {
  SimulatorClientsExample,
  SimulatorControlExample,
  SimulatorInstrumentExample,
  SimulatorMonitorExample,
} from "./SimulatorExamples";
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
    id: "channel-picker-workspace",
    group: "ChannelPicker",
    title: "Title bar picker (workspace channel)",
    description:
      "Click a channel to switch every bound panel to it (the pinned Depth stays on Blue). Click the active channel, or its search button, to find an instrument: ↑↓ move, Enter links it, Tab switches channel, Esc closes.",
    Component: ChannelPickerWorkspace,
  },
  {
    id: "channel-picker-fit",
    group: "ChannelPicker",
    title: "Fit: full, compact, dots",
    description:
      "Full (dot, ric, price) when every channel fits, else compact (dot, ric), else dots with only the active channel's ric. Force a density or drag the width slider.",
    Component: ChannelPickerFit,
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
    id: "instrument-grid-futures",
    group: "InstrumentGrid",
    title: "Futures",
    description:
      "Futures (front and next quarter on AAPL.OQ, VOD.L and the STECH index in local mode; ?futures= for others), grouped by underlying with expiry, multiplier and settlement columns.",
    Component: InstrumentGridFutures,
  },
  {
    id: "instrument-grid-continuations",
    group: "InstrumentGrid",
    title: "Continuations",
    description:
      "Continuation rics (AAPLc1, AAPLc2, ...): each mirrors the quotes of the contract in its contract column and is repointed at each roll.",
    Component: InstrumentGridContinuations,
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
    id: "order-book-view",
    group: "OrderBookView",
    title: "Selected order: L2 depth and L3 queue position",
    description:
      "Select a working order in the blotter: its levels are marked in the depth, and the queue at the selected level shows its position, size ahead and the orders around it. Click a level or a child order to see that queue.",
    Component: OrderBookViewExample,
  },
  {
    id: "fills-blotter",
    group: "FillsBlotter",
    title: "Fills with grouping, VWAP and CSV export",
    Component: FillsBlotterExample,
  },
  {
    id: "simulator-monitor",
    group: "Simulator",
    title: "Books, bots and bot detail",
    description:
      "sim-admin tables: simBooks sorted by gap to fair, every bot with P&L and order flow, and the selected bot's stats and parameters. Selecting a row links the instrument.",
    Component: SimulatorMonitorExample,
  },
  {
    id: "simulator-instrument",
    group: "Simulator",
    title: "Fair value, flow and attributed fills",
    description:
      "simSamples for AAPL.OQ: fair value, walk and quotes over signed volume by owner group, and botFills with markouts. The showcase runs with market impact off, so fair and walk coincide.",
    Component: SimulatorInstrumentExample,
  },
  {
    id: "simulator-control",
    group: "Simulator",
    title: "Session, scenarios and instrument controls",
    description:
      "Force the session phase, pause every bot or run a scenario; change AAPL.OQ's price model, jump its fair value, set bot rates or add a bot. Every change shows in the control log (simEvents).",
    Component: SimulatorControlExample,
  },
  {
    id: "simulator-clients",
    group: "Simulator",
    title: "Client bots",
    description:
      "Simulated clients in the OMS (clientBots): add a pension, hedge fund, quant, liquidation or informed client and watch its TWAP / VWAP / POV parents, fills and slippage. Select one to edit its parameters, pause it or send an algo now.",
    Component: SimulatorClientsExample,
  },
  {
    id: "server-metrics",
    group: "Simulator",
    title: "Server metrics",
    description:
      "METRICS tables from the in-browser sim and OMS: every timer, counter and gauge with trends of its rate and p99, table writes, and the selected metric's history (metricsHistory). Click a row to chart it.",
    Component: ServerMetricsExample,
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
    id: "price-chart",
    group: "PriceChart",
    title: "Price chart (candles + fills)",
    description:
      "Candlesticks from the exchange bars table for the selected instrument, with volume, VWAP, the visible accounts' fills as BUY / SELL markers and last / average-fill mark lines. Switch interval in the chart toolbar; trade in the Stack examples to see new fill markers.",
    Component: PriceChartExample,
  },
  {
    id: "depth-chart",
    group: "DepthChartView",
    title: "Depth chart",
    description:
      "Live cumulative depth (stepped) for the selected instrument, above the spread / imbalance chart from bookSamples.",
    Component: DepthChartExample,
  },
  {
    id: "spread-chart",
    group: "SpreadChart",
    title: "Spread / imbalance",
    description:
      "Spread in bps and top-5 book imbalance (-1..+1) over the last 5 minutes of bookSamples for the selected instrument.",
    Component: SpreadChartExample,
  },
  {
    id: "time-series-chart",
    group: "TimeSeriesChart",
    title: "Large time series (streamed M4 buckets)",
    description:
      "Five years of 1 s mid / spread per instrument (generated per bucket on demand, so any second can be drilled into) as a subscription: the chart sets a time window (with overscan, about one bucket per pixel) and the server streams M4 buckets as timeSeriesBuckets rows, inserting / deleting as you pan and updating the last bucket as prices tick. Range buttons 1h to 5y; wheel to zoom, drag to pan. See docs/timeseries-downsampling.md.",
    Component: TimeSeriesChartExample,
  },
  {
    id: "pnl-history-chart",
    group: "PnlHistoryChart",
    title: "P&L history",
    description:
      "Total / realized / unrealized P&L in USD from accountPnlHistory for the selected account.",
    Component: PnlHistoryChartExample,
  },
  {
    id: "exposure-treemap",
    group: "ExposureTreemap",
    title: "Exposure treemap",
    description:
      "positionPrices grouped by sector then instrument; tile area is |USD market value| (or |USD P&L|), colour the sign. Left: every account; right: ACC-US-01.",
    Component: ExposureTreemapExample,
  },
  {
    id: "slippage-chart",
    group: "SlippageChart",
    title: "Slippage vs arrival",
    description:
      "Execution quality: slippage (bps, positive = worse) of each filled parent order against its arrival price, coloured by side.",
    Component: SlippageChartExample,
  },
  {
    id: "chart-workspace",
    group: "Charts",
    title: "Chart workspace (perf)",
    description:
      "Price chart (1s bars), depth chart, spread / imbalance and MarketDepth for one instrument at once - the perf:ui chart scenario.",
    Component: ChartWorkspace,
  },
  {
    id: "price-ladder-live",
    group: "PriceLadder",
    title: "Live ladder",
    description:
      "Click bid / ask to trade (ACC-US-01), drag or M+arrows+Enter to amend, Delete / double-click to cancel, C to centre. Queue is on: Q shows the orders at the cursor price.",
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
    id: "panel-link-group",
    group: "Selectors",
    title: "Link group in panel headers",
    description:
      "PanelLinkGroupSelector in grid-layout panels: an icon-only LinkGroupMenuButton in each header.",
    Component: PanelLinkGroupExample,
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
