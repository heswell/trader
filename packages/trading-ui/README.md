# @heswell/trading-ui

Reusable trading React components built on Vuu (`@vuu-ui/*`) and Salt. They do not depend on a particular data
source: the same component runs on local test data, against a Vuu server, or as a module-federation feature
inside vuu-portal. **Conventions: [docs/ui-guide.md](../../docs/ui-guide.md).**

| Area | Exports |
| --- | --- |
| Data | `TradingDataProvider` (`inherit` / `local` / `remote`), `useTradingDataSource(table, options?)`, `useTradingDataMode`, `useHasDataProvider`, `connectToVuuServer`, `disconnectFromVuuServer`, `sendTradingRpc`, `TradingRpcError`, `tradingTableSchema`, `tradingVuuTable`, `tradingColumnNames` |
| Instrument context (P3.11 placeholder) | `InstrumentContextProvider`, `useSelectedInstrument`, `SelectedInstrument`, `InstrumentContextValue` |
| Formatting | `formatPrice`, `priceDecimals`, `formatQuantity`, `formatNotional`, `formatPercent` |
| Colours | `TradingColour`, `sideColour`, `directionColour`, `orderStatusCategory`, `orderStatusColour`, `tradingPhaseColour` |
| User settings | `UserSettingsStorage`, `UserSettingsProvider`, `useUserSettingsStorage`, `createLocalSettingsStorage`, `createMemorySettingsStorage` |
| Components | `SideLabel` (reference component), `InstrumentGrid`, `Sparkline` / `trading.sparkline` renderer, `OrderTicket` / `OrderTicketDialog` / `OrderTicketPanel` + `useOrderTicketLauncher` ([README](src/components/OrderTicket/README.md)), `InstrumentPicker`, `ConnectionBanner`, `StaleIndicator` |
| Rows | `useTradingRows(table, { filter, rowCount })` → `{ dataSource, rows }`, `subscribeTradingRows`, `toTradingRowObject` |
| Notifications, connection | `TradingNotificationsProvider`, `useTradingNotifications`, `TradingOrderEvent`, `useTradingConnectionStatus`, `useStaleIndicator` ([README](src/notifications/README.md)) |

```tsx
const Orders = () => {
  const dataSource = useTradingDataSource("parentOrders");
  return <Table config={config} dataSource={dataSource} />;
};
```

## InstrumentGrid (P3.2)

A preset over the vuu `Table` bound to `instrumentPrices` (or `prices`: columns that do not exist are dropped).

```tsx
<InstrumentGrid onBuy={(i) => ...} onSell={(i) => ...} onOpenDepth={(i) => ...} />
```

| Prop | Meaning |
| --- | --- |
| `dataSource?` / `table?` | Supply a data source, or bind `"instrumentPrices"` (default) / `"prices"`. |
| `columns?` | Visible column names in order (default: ric, description, exchange, currency, bid, ask, last, change, changePct, phase, sparkline, volume, turnover). The "Columns" button opens the vuu column picker; the header menu gives sort / group / hide. |
| `simulatedOnly?` | Default true: only instruments quoted by the simulator (instrumentPrices). |
| `initialGroupBy?` | `exchange` / `sector` / `currency`; volume and turnover are summed in group rows. |
| `sparkline?` | `false` or `{ valueColumn, length, bucketMs, ignoreZero }`. |
| `showToolbar?` | Quick filter (ric / description), watchlist selector + manager, group-by, columns, Buy/Sell/Depth buttons. |
| `onBuy` / `onSell` / `onOpenDepth` | `(instrument: SelectedInstrument) => void`. The context-menu items and toolbar buttons exist only when the prop is set. There are no server menu RPCs. |
| `watchlistStorage?` | `UserSettingsStorage` override for the watchlists. |

Row selection calls `setSelectedInstrument(instrument, "InstrumentGrid")`. Cell renderers (registered by the grid, or by
`registerInstrumentGridRenderers()`): `trading.price-move` (flash + optional arrow), `trading.change`
(sign + arrow + colour; `percent`), `trading.quantity`, `trading.phase` (dot + label; HALTED / CLOSED
styled). Prices are formatted with the row's `priceDecimals` / `tickSize` / `tickBands`. Pure helpers are exported too:
`buildInstrumentGridFilter`, `instrumentGridColumns`, watchlist functions and `useWatchlists`.

**Watchlists and user settings.** Watchlists are client-side lists of rics stored under `trading.watchlists` through a
`UserSettingsStorage` (a `getItem` / `setItem` subset of Web Storage, may be async). The default is localStorage
(memory fallback). In vuu-portal, wrap the feature in `<UserSettingsProvider storage={portalStorage}>` where
`portalStorage` reads / writes the user's settings document in the portal backend; no component changes are needed.

## Sparkline (P3.3)

`trading.sparkline` cell renderer (a `source: "client"` column, see `instrumentGridColumn("sparkline")`) or the
presentational `<Sparkline values={[...]} />`. Each visible row keeps a `Float64Array` ring buffer
(`length` samples, 8 bytes each: 40 samples = 320 B per row) in a ref-counted `sparklineStore`; the buffer is freed when the
row's cell unmounts or is recycled (the row leaves the viewport), so only rows in the viewport cost memory, and a row's
history restarts when it comes back. `bucketMs > 0` samples on a constant time axis instead of per change. The polyline is
updated imperatively (no React render per tick). Zero values are skipped by default (`ignoreZero`) because a row has 0
until its first price.

*Future:* a server-provided intraday series column (e.g. `last` history as a `string` / array column on `prices`, or an
`intradaySeries` table keyed by ric) could replace the client buffer: the renderer would draw the column value when it
holds a series and fall back to the buffer otherwise, so history would survive scrolling and reloads.

### Performance (headless Chrome, local test data, 1400x900, in-browser exchange + OMS on the same thread)

| Scenario | Frame median / p95 | Main thread busy | Notes |
| --- | --- | --- | --- |
| 50 ticking instruments, 45 rows rendered | 16.7 / 16.8 ms | ~38% (script 25%) | |
| 200 ticking, 45 rows rendered | 16.7 / 16.8 ms | ~54% (script 39%) | 60 fps |
| 200 ticking, all 200 rows rendered (5000px tall) | 50 / 133 ms | ~100% | stress; the plain vuu price-move table at 154 rows was already ~97% busy |

Run it yourself: `?active=200` on the showcase URL, example "InstrumentGrid / 200 ticking rows (perf)".

Tests: `bun run test:ui` (bun:test + @testing-library/react on happy-dom).

## Blotters, tape and positions (P3.7–P3.10)

All four wrap themselves in `InstrumentLookupProvider` (one `instruments` subscription, reused if nested) and
set the selected instrument via `useSelectedInstrument()`.

| Component | Props |
| --- | --- |
| `OrderBlotter` | `defaultTab` (`working` \| `filled` \| `closed` \| `all`), `showChildOrders` (default true), `onOrderSelect(orderId?)`, `onError(TradingRpcError)`, `useEditSession` (amend through the server edit session instead of `amendOrder`). Tabs filter client side on `status`. Amend / cancel icons are enabled only for NEW, PARTIALLY_FILLED, REPLACED. Multi-select (ctrl / shift click) + **Cancel selected** sends `cancelOrder` per order; **Cancel all** sends `cancelAll`. Amend opens a dialog (quantity, price). Child orders of the selected order show in a panel below (a vuu LinkedTableView / tree does not span tables in alpha.20). Rejected rows show `rejectReason: text` as a tooltip on the status. |
| `FillsBlotter` | `defaultGrouping` (`none` \| `ric` \| `ric-side`), `ric`, `onOrderSelect(orderId)` (order link), `highlightOrderId`, `csvFileName`. Group rows show summed quantity / notional and VWAP (`sum(notional) / sum(quantity)`, computed in the renderer – vuu has no VWAP aggregation). **Export CSV** writes the current filter and sort, ungrouped, up to 5,000 rows. |
| `TradeTape` | `ric` (default: selected instrument), `maxRows` (100), `largeSizeThreshold` (absolute) or `largeSizePercentile` (90), `utc`. Newest first (`seq` descending), one render per animation frame, aggressor shown as ▲ Buy / ▼ Sell plus colour. |
| `PositionsView` | `defaultGrouping` (`none` \| `account` \| `ric`; groups are always by currency first), `account`, `showTotals`. Realised / unrealised / total P&L tick via `positionPrices`. The totals table is **per currency** (never mixed; GBX is pence). No sector grouping: positions has no sector column. |

Shared pieces (all exported): `OrderStatusBadge`, `FillProgressBar`, `PnlValue`; cell renderers registered by
`registerTradingCellRenderers()` and named in `TradingRenderer` (`trading.order-status`, `trading.side`,
`trading.fill-progress`, `trading.price`, `trading.pnl`, `trading.position-quantity`, `trading.notional`,
`trading.time`, `trading.liquidity`) – use them as a column `type: { name: "string", renderer: { name } }`;
`useInstrumentLookup`, `useDataSourceRecords` (rAF-coalesced records from a data source you own),
`useTableSelectedKeys`, `editOrdersInSession`, and the `formatTime`, `rowsToCsv` / `downloadCsv` and order status
helpers (`isOrderAmendable`, `WORKING_STATUSES`, ...).
