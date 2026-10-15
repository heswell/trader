# InstrumentGrid (P3.2), Sparkline (P3.3) and the grid cell renderers

Reference (props, types, defaults): [InstrumentGrid](../api/trading-ui.md#instrumentgrid),
[Sparkline](../api/trading-ui.md#sparkline), [SparklineCell](../api/trading-ui.md#sparklinecell),
[PriceMoveCell](../api/trading-ui.md#pricemovecell), [ChangeCell](../api/trading-ui.md#changecell),
[QuantityCell](../api/trading-ui.md#quantitycell), [PhaseCell](../api/trading-ui.md#phasecell).

Showcase: `#instrument-grid`, `#instrument-grid-prices`, `#instrument-grid-200` (perf), `#primitives-cell-renderers`
(the renderers in a plain vuu `Table`), `#hosting-user-settings` (watchlist storage).

| | |
| --- | --- |
| Tables | `instrumentPrices` (default) or `prices`; `instruments` through `InstrumentLookupProvider` |
| RPCs | none itself. Buy / Sell open the order ticket, which sends `createOrder`. |
| Roles | none in the component. Pass `launchOrderTicket={canTrade}` to hide Buy / Sell for view-only users (as the Watchlist feature does). |
| Class base | `tradingInstrumentGrid`, cells `tradingInstrumentCell`; `data-direction`, `data-phase`, `data-link-group` |

## InstrumentGrid

A preset over the vuu `Table` bound to `instrumentPrices` (or `prices`: columns that do not exist are dropped).

```tsx
<InstrumentGrid onBuy={(i) => ...} onSell={(i) => ...} onOpenDepth={(i) => ...} />
```

| Prop | Meaning |
| --- | --- |
| `dataSource?` / `table?` | Supply a data source, or bind `"instrumentPrices"` (default) / `"prices"`. |
| `columns?` | Visible column names in order (default: ric, description, exchange, currency, bid, ask, last, change, changePct, phase, sparkline, volume, turnover). The "Columns" button opens the vuu column picker; the header menu gives sort / group / hide. |
| `simulatedOnly?` | Default false. True: only instruments quoted by the simulator (instrumentPrices). Unquoted instruments show empty price cells. |
| `initialGroupBy?` | `exchange` / `sector` / `currency`; volume and turnover are summed in group rows. |
| `sparkline?` | `false` or `{ valueColumn, length, bucketMs }`. |
| `showToolbar?` | Quick filter (ric / description), watchlist selector + manager, group-by, columns, Buy/Sell/Depth buttons. |
| `onBuy` / `onSell` / `onOpenDepth` | `(instrument: SelectedInstrument) => void`. The context-menu items and toolbar buttons exist only when the prop is set, or (Buy / Sell) when an `OrderTicketLauncherProvider` is mounted. The menu items are client-side and call direct RPCs; vuu-server 3.3.0 supports server menu RPCs, but trader declares none (trader upstream issues 11 and 63–66 in [upstream-issues.md](../upstream-issues.md)). |
| `launchOrderTicket?` | Default `true`: without `onBuy` / `onSell`, Buy / Sell open the ticket via `useOrderTicketLauncher()` when a launcher is present. |
| `followSelection?` | Default `true`: select and highlight the row of the instrument selected elsewhere in the link group. It clears for an unknown ric, and does not scroll (trader upstream issue 37). |
| `LinkGroupProps` | `linkGroup`, `defaultLinkGroup`, `onLinkGroupChange`, `showLinkGroupSelector` (toolbar). |
| `watchlistStorage?` | `UserSettingsStorage` override for the watchlists. |

Row selection calls `setSelectedInstrument(instrument, "InstrumentGrid")`. Pure helpers are exported too:
`buildInstrumentGridFilter`, `instrumentGridColumns`, watchlist functions and `useWatchlists`.

**Watchlists and user settings.** Watchlists are client-side lists of rics stored under `trading.watchlists` through a
`UserSettingsStorage` (a `getItem` / `setItem` subset of Web Storage, may be async). The default is localStorage
(memory fallback). In vuu-portal, wrap the feature in `<UserSettingsProvider storage={portalStorage}>` where
`portalStorage` reads / writes the user's settings document in the portal backend; no component changes are needed.
See [hosting.md](hosting.md#usersettingsprovider).

## Cell renderers

Registered when the grid module is imported, or explicitly with `registerInstrumentGridRenderers()`. Use them in any
vuu `Table` column as `type: { name: "number", renderer: { name, componentProps } }` (example:
`apps/showcase/src/examples/PrimitivesExamples.tsx`, showcase `#primitives-cell-renderers`).

| Renderer name | Component | `componentProps` | |
| --- | --- | --- | --- |
| `trading.price-move` | `PriceMoveCell` | `arrow?` | Flash on change, optional up / down arrow (the grid turns it on for `last`). |
| `trading.change` | `ChangeCell` | `percent?` | Sign + arrow + colour. |
| `trading.quantity` | `QuantityCell` | `compact?` | Grouped or compact (1.2M) quantity. |
| `trading.phase` | `PhaseCell` | | Dot + label; HALTED / CLOSED styled. |
| `trading.sparkline` | `SparklineCell` | `valueColumn`, `length`, `bucketMs` | See below. |

Prices are formatted with the row's `priceDecimals` / `tickSize` / `tickBands` when those columns are in the
subscription (they can be hidden). The blotter renderers (`trading.order-status`, `trading.side`, ...) are listed in
[blotters.md](blotters.md#shared-pieces).

## Sparkline

`trading.sparkline` cell renderer (a `source: "client"` column, see `instrumentGridColumn("sparkline")`) or the
presentational `<Sparkline values={[...]} />`. Each visible row keeps a `Float64Array` ring buffer
(`length` samples, 8 bytes each: 40 samples = 320 B per row) in a ref-counted `sparklineStore`; the buffer is freed when the
row's cell unmounts or is recycled (the row leaves the viewport), so only rows in the viewport cost memory, and a row's
history restarts when it comes back. `bucketMs > 0` samples on a constant time axis instead of per change. The polyline is
updated imperatively (no React render per tick). Null values (no trade yet) are not sampled.

*Future:* a server-provided intraday series column (e.g. `last` history as a `string` / array column on `prices`, or an
`intradaySeries` table keyed by ric) could replace the client buffer: the renderer would draw the column value when it
holds a series and fall back to the buffer otherwise, so history would survive scrolling and reloads.

### Performance (headless Chrome, local test data, 1400x900, in-browser exchange + OMS on the same thread)

| Scenario | Frame median / p95 | Main thread busy | Notes |
| --- | --- | --- | --- |
| 50 ticking instruments, 45 rows rendered | 16.7 / 16.8 ms | ~38% (script 25%) | |
| 200 ticking, 45 rows rendered | 16.7 / 16.8 ms | ~54% (script 39%) | 60 fps |
| 200 ticking, all 200 rows rendered (5000px tall) | 50 / 133 ms | ~100% | stress; the plain vuu price-move table at 154 rows was already ~97% busy |

Run it yourself: `?active=200` on the showcase URL, example "InstrumentGrid / 200 ticking rows (perf)". Later
numbers and tooling: [performance.md](../performance.md).
