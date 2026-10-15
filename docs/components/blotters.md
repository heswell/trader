# Blotters, tape and positions (P3.7–P3.10)

Reference: [OrderBlotter](../api/trading-ui.md#orderblotter), [FillsBlotter](../api/trading-ui.md#fillsblotter),
[TradeTape](../api/trading-ui.md#tradetape), [PositionsView](../api/trading-ui.md#positionsview).

Showcase: `#order-blotter`, `#fills-blotter`, `#trade-tape`, `#positions-view`, all four in `#trader-workspace`.

| Component | Tables | RPCs | Roles |
| --- | --- | --- | --- |
| `OrderBlotter` | `parentOrders`, `childOrders` (selected order) | `cancelOrder`, `cancelAll`, `amendOrder`, or a `parentOrders` edit session with `useEditSession` | `readOnly` hides amend / cancel; pass `readOnly={!canTrade}` for users without `trading-execute` |
| `FillsBlotter` | `fills` | – | view only |
| `TradeTape` | `trades` | – | view only |
| `PositionsView` | `positionPrices` | – | view only |

Rows are filtered by the OMS per user (see [permissions](README.md#permissions)), so a supervisor sees every
account on their desks with the same component.

All four wrap themselves in `InstrumentLookupProvider` (one `instruments` subscription, reused if nested) and
publish the selected instrument to their link group (`LinkGroupProps`: `linkGroup`, `defaultLinkGroup`,
`showLinkGroupSelector`, `onLinkGroupChange`). The tape follows its group.

| Component | Props |
| --- | --- |
| `OrderBlotter` | `defaultTab` (`working` \| `filled` \| `closed` \| `all`), `showChildOrders` (default true), `onOrderSelect(orderId?)`, `onError(TradingRpcError)`, `notify` (default true: failed amend / cancel requests also go to `useTradingNotifications()` when a provider is mounted), `readOnly` (default false: hide the amend / cancel controls), `useEditSession` (amend through the server edit session instead of `amendOrder`: the dialog begins the session when it opens, Amend saves it, Close discards it, and an order that changed meanwhile is refused as stale). Tabs filter client side on `status`. Amend / cancel icons are enabled only for NEW, PARTIALLY_FILLED, REPLACED. Multi-select (ctrl / shift click) + **Cancel selected** sends `cancelOrder` per order; **Cancel all** sends `cancelAll`. Amend opens a dialog (quantity, price). Child orders of the selected order show in a panel below (a vuu LinkedTableView / tree does not span tables, still the case in alpha.21). Rejected rows show `rejectReason: text` as a tooltip on the status. |
| `FillsBlotter` | `defaultGrouping` (`none` \| `ric` \| `ric-side`), `ric`, `onOrderSelect(orderId)` (order link), `highlightOrderId`, `csvFileName`. Group rows show summed quantity / notional and VWAP (`sum(notional) / sum(quantity)`, computed in the renderer – vuu has no VWAP aggregation). **Export CSV** writes the current filter and sort, ungrouped, up to 5,000 rows. |
| `TradeTape` | `ric` (default: selected instrument), `maxRows` (100), `largeSizeThreshold` (absolute) or `largeSizePercentile` (90), `utc`. Newest first (`seq` descending), one render per animation frame, aggressor shown as ▲ Buy / ▼ Sell plus colour. |
| `PositionsView` | `defaultGrouping` (`sector` (default) \| `none` \| `account` \| `ric`; groups are always by currency first), `account`, `showTotals`. Realised / unrealised / total P&L tick via `positionPrices`. `sector` and `exchange` come from instrument static (the OMS copies them onto `positions`). The totals table is **per currency** (never mixed; GBX is pence). |

```tsx
const { canTrade } = useEntitlements(); // your app's role check
<OrderBlotter defaultLinkGroup="red" readOnly={!canTrade} showLinkGroupSelector useEditSession />
<FillsBlotter defaultGrouping="ric" onOrderSelect={setOrderId} />
<PositionsView defaultGrouping="account" />
```

The RPC contracts and error reasons (`TOO_LATE_TO_CANCEL`, `ORDER_PENDING`, ...) are in
[packages/oms/README.md](../../packages/oms/README.md#rpcs); the edit session in
[Blotter inline edit](../../packages/oms/README.md#blotter-inline-edit-edit-session).

## CSS hooks

Class bases `tradingOrderBlotter`, `tradingFillsBlotter`, `tradingTradeTape`, `tradingPositionsView`. Useful
attributes: `data-link-group`, `data-testid`, `data-connection-state` / `data-error` (OrderBlotter),
`data-aggressor` / `data-large` (TradeTape), `data-currency` (PositionsView). The full list is in the
[catalogue](../api/components.md#css-hooks).

## Shared pieces

All exported:

- `OrderStatusBadge`, `FillProgressBar`, `PnlValue` (see [primitives.md](primitives.md)).
- Cell renderers registered by `registerTradingCellRenderers()` and named in `TradingRenderer` (`trading.order-status`,
  `trading.side`, `trading.fill-progress`, `trading.price`, `trading.pnl`, `trading.position-quantity`,
  `trading.notional`, `trading.time`, `trading.liquidity`). Use them as a column
  `type: { name: "string", renderer: { name } }`.
- `useInstrumentLookup`, `useDataSourceRows` (rAF-coalesced rows from a data source you own), `useTableSelectedKeys`,
  `editOrdersInSession` / `openOrderEditSession` (`StaleOrderEditError` on a stale save).
- `formatTime`, `rowsToCsv` / `downloadCsv` and the order status helpers (`isOrderAmendable`, `WORKING_STATUSES`, ...).
