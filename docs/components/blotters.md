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
| `OrderBlotter` | `defaultTab` (`working` \| `filled` \| `closed` \| `all`), `showChildOrders` (default true), `onOrderSelect(orderId?)`, `onError(TradingRpcError)`, `notify` (default true: failed amend / cancel requests also go to `useTradingNotifications()` when a provider is mounted), `readOnly` (default false: hide the amend / cancel controls), `useEditSession` (amend through the server edit session instead of `amendOrder`: the dialog begins the session when it opens, Amend saves it, Close discards it, and an order that changed meanwhile is refused as stale). Tabs filter client side on `status`. Amend / cancel icons are enabled only for NEW, PARTIALLY_FILLED, REPLACED. Multi-select (ctrl / shift click) + **Cancel selected** sends `cancelOrder` per order; **Cancel all** sends `cancelAll`. Amend opens a dialog (quantity, price). Child orders of the selected order show in a panel below (a vuu LinkedTableView / tree does not span tables, still the case in alpha.21). Rejected rows show `rejectReason: text` as a tooltip on the status. **Order book** (`showOrderBook`, default true) opens the selected order's book in the shell's context panel, or in a dialog outside a portal shell; the panel follows the selection (see [Order book panel](#order-book-panel)). |
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

## Order book panel

`OrderBookView` (`orderId`, `levels` (default 10), `level` / `onLevelChange`) shows the book a parent order is
working in, read top down:

1. **Order**: side, quantity, instrument, limit / strategy / TIF, and a bar of filled, resting and not yet sent.
   Below it, one chip per working child order that is in the book, with its queue position (`#4 of 9 · 6,300
   ahead`).
2. **Level 2**: the instrument's `depth` levels, asks above bids. A dot marks the levels holding the order, and
   each row ends in a strip of the L3 queue (one segment per resting order, the order's own in the
   `--trading-own-order` colour).
3. **Level 3**: the queue at the selected level from `bookOrders`, front first: a proportional bar, the
   order's position / size ahead / behind / size, and the orders (exchange id, size, size ahead, age), the
   order's own labelled with its child order id.

It opens on the level of the best-placed working child order, else the best price on the order's side. Click a
level or a child order chip to see that queue. Data comes from `useOrderBook(orderId)`: the parent order, its
`childOrders`, `useMarketDepth` and `useBookQueue` with the working child orders' exchange ids. When
`bookOrders` is empty but `depth` is not, the server has L3 off and the panel says so; when an instrument has
more resting orders than `useBookQueue` loads (`truncated`), it says the queues may be incomplete.

In a vuu context panel, the panel widens to `min(480px, 90vw)` while it shows an order book (vuu's default is
300px). Set `--tradingOrderBookView-panelWidth` (for example on `:root`) to choose another width.

The layout holds still while the book ticks: each side of the depth always takes `levels` rows (blank rows pad the
asks above and the bids below), the child order chips sit in one fixed-height row that scrolls sideways, and the
queue table has fixed column widths.

The blotter renders the panel content inside its own React tree (`SlotContextPanelProvider` portals it into the
shell's panel), so the content sees the blotter's data providers and follows its selection without being
reopened.

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
