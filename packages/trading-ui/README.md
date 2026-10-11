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
| Components | `SideLabel` (reference component) |

```tsx
const Orders = () => {
  const dataSource = useTradingDataSource("parentOrders");
  return <Table config={config} dataSource={dataSource} />;
};
```

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
