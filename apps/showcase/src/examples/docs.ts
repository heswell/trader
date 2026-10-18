/**
 * Guide (repo-relative path#anchor) for every reusable component and
 * showcase group. The showcase links each group to its guide, and
 * `bun run docs:check` fails when a component or group has no entry.
 */
export const COMPONENT_GUIDES: Record<string, string> = {
  // components
  AccountSelector: "docs/components/selection-and-linking.md#accounts",
  ChangeCell: "docs/components/instrument-grid.md#cell-renderers",
  ConnectionBanner: "docs/components/notifications-and-connection.md",
  ConnectionStatusIndicator: "docs/components/notifications-and-connection.md",
  DepthChartView: "docs/components/charts.md#depthchartview",
  ExposureTreemap: "docs/components/charts.md#exposuretreemap",
  FillProgressBar: "docs/components/primitives.md",
  FillsBlotter: "docs/components/blotters.md",
  InstrumentContextProvider:
    "docs/components/selection-and-linking.md#how-linking-works",
  InstrumentGrid: "docs/components/instrument-grid.md#instrumentgrid",
  InstrumentLookupProvider: "docs/components/selection-and-linking.md",
  InstrumentPicker: "docs/components/selection-and-linking.md",
  LinkGroupProvider:
    "docs/components/selection-and-linking.md#how-linking-works",
  LinkGroupSelector: "docs/components/selection-and-linking.md",
  LinkGroupSwatch: "docs/components/selection-and-linking.md",
  MarketDepth: "docs/components/market-depth-and-ladder.md#marketdepth",
  OrderBlotter: "docs/components/blotters.md",
  OrderStatusBadge: "docs/components/primitives.md",
  OrderTicket: "docs/components/order-ticket.md",
  OrderTicketDialog: "docs/components/order-ticket.md",
  OrderTicketLauncherProvider: "docs/components/order-ticket.md#prefill",
  OrderTicketPanel: "docs/components/order-ticket.md",
  PhaseCell: "docs/components/instrument-grid.md#cell-renderers",
  PnlHistoryChart: "docs/components/charts.md#pnlhistorychart",
  PnlValue: "docs/components/primitives.md",
  PriceChart: "docs/components/charts.md#pricechart",
  PositionsView: "docs/components/blotters.md",
  PriceLadder: "docs/components/market-depth-and-ladder.md",
  PriceLadderView: "docs/components/market-depth-and-ladder.md",
  PriceMoveCell: "docs/components/instrument-grid.md#cell-renderers",
  QuantityCell: "docs/components/instrument-grid.md#cell-renderers",
  SideLabel: "docs/components/primitives.md",
  SlippageChart: "docs/components/charts.md#slippagechart",
  Sparkline: "docs/components/instrument-grid.md#sparkline",
  SparklineCell: "docs/components/instrument-grid.md#sparkline",
  SpreadChart: "docs/components/charts.md#spreadchart",
  StaleIndicator: "docs/components/notifications-and-connection.md",
  TradeTape: "docs/components/blotters.md",
  TradingConnectionStateOverride:
    "docs/components/hosting.md#tradingconnectionstateoverride",
  TradingDataProvider: "docs/components/hosting.md#tradingdataprovider",
  TradingFeatureRoot: "docs/components/hosting.md#tradingfeatureroot",
  TradingNotificationsProvider:
    "docs/components/notifications-and-connection.md",
  UserSettingsProvider: "docs/components/hosting.md#usersettingsprovider",
  // showcase groups
  Charts: "docs/components/charts.md",
  Hosting: "docs/components/hosting.md",
  Linking: "docs/components/selection-and-linking.md",
  Primitives: "docs/components/primitives.md",
  Selectors: "docs/components/selection-and-linking.md",
  Stack: "docs/components/README.md",
  Workspace: "docs/components/README.md",
  Notifications: "docs/components/notifications-and-connection.md",
};
