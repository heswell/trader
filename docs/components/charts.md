# Charts

Six chart components in `@heswell/trading-ui`, built on `@vuu-ui/vuu-chart` (echarts) and the chart tables described
in [charting-data.md](../charting-data.md). Like the other components they read through the Vuu protocol, so they work
on the local test data and against a remote server, and they follow the linked instrument.

Showcase examples: `#price-chart`, `#depth-chart`, `#spread-chart`, `#pnl-history-chart`, `#exposure-treemap`,
`#slippage-chart` and `#chart-workspace` (every chart ticking at once).

Reference: [PriceChart](../api/trading-ui.md#pricechart), [DepthChartView](../api/trading-ui.md#depthchartview),
[SpreadChart](../api/trading-ui.md#spreadchart), [PnlHistoryChart](../api/trading-ui.md#pnlhistorychart),
[ExposureTreemap](../api/trading-ui.md#exposuretreemap), [SlippageChart](../api/trading-ui.md#slippagechart),
[useChartDataSource](../api/trading-ui.md#usechartdatasource).

| Component | Tables | Follows | Portal feature |
| --- | --- | --- | --- |
| `PriceChart` | `bars`, `fills` | linked instrument | **Chart** (also in the Trader workspace) |
| `DepthChartView` | `depth` | linked instrument | **Depth chart** (also in the Trader workspace) |
| `SpreadChart` | `bookSamples` | linked instrument | showcase only (`#depth-chart`, `#spread-chart`) |
| `PnlHistoryChart` | `accountPnlHistory` | selected account | **Analytics** |
| `ExposureTreemap` | `positionPrices` | `account` prop | **Analytics** |
| `SlippageChart` | `parentOrders` | `account` / `ric` props | **Analytics** |

None of them call RPCs, so they are all view-only: `trading-view` users (dave) get the same charts as traders. OMS
tables are account-filtered on the server, so fills, P&L, positions and slippage only show accounts the user can see.

## How the charts get their data

vuu-chart subscribes each DataSource itself (rows `0..maxRows`, no client filter or sort) and **unsubscribes it on
unmount and whenever the DataSource changes**. So:

- Every chart, and every overlay, has its own DataSource. Never pass a DataSource shared with a table or another chart.
- Filter and sort go into the DataSource (the server filters), not into the chart: `bars` are filtered by `ric` and
  `interval` and sorted newest first so the last `maxRows` bars are read.
- A new instrument, interval or account creates a new DataSource; the chart swaps to it and drops the old one.

`useChartDataSource(table, { columns, filter, sort, disabled })` does this. It builds a fresh remote or engine-local
DataSource (whichever `TradingDataProvider` supplies) whenever its inputs change, and never unsubscribes it itself:

```tsx
const bars = useChartDataSource("bars", {
  columns: ["id", "start", "open", "high", "low", "close", "volume"],
  filter: `ric = "VOD.L" and interval = "1m"`,
  sort: { column: "start", direction: "D" },
  disabled: !ric, // returns undefined: show a "Select an instrument" message
});
return bars ? <CandlestickChart dataSource={bars} timeColumnName="start" /> : null;
```

Function props (`where`, `formatValue`, `formatTime`) and `echartsOptions` are compared structurally by vuu-chart:
define them at module level so they are stable.

## PriceChart

Candles from `bars` for one instrument and interval, with:

- a **volume** pane (bars coloured by direction);
- a **VWAP** line (the per-bar `vwap`);
- the user's **fills** as diamond markers, green for BUY and red for SELL, from `fills` filtered by `ric` (and
  `account`), plus an **Avg fill** mark line (quantity-weighted);
- a **Last** mark line on the latest close;
- an **interval selector** (1s / 1m / 5m) in the toolbar; mouse-wheel / drag to zoom and pan.

```tsx
<PriceChart />                                  // follows the linked instrument, 1m bars
<PriceChart ric="VOD.L" defaultInterval="1s" account="ACC-UK-01" />
<PriceChart interval={interval} onIntervalChange={setInterval} showVolume={false} />
```

| Prop | Type | Default | Notes |
| --- | --- | --- | --- |
| `ric` | `string` | linked instrument | Explicit instrument override. |
| `linkGroup` / `defaultLinkGroup` / `onLinkGroupChange` / `showLinkGroupSelector` | `LinkGroupProps` | inherited, else `red` | Link group to follow (ui-guide §5). |
| `interval` / `defaultInterval` / `onIntervalChange` | `string` | `"1m"` | Controlled or uncontrolled bar interval. |
| `intervals` | `string[]` | `PRICE_CHART_INTERVALS` (`1s`, `1m`, `5m`) | Must match `exchangeSim.barIntervals`. |
| `showFills` / `account` | `boolean` / `string` | `true` / all visible | Fill markers and their account filter. |
| `showVwap` / `showVolume` | `boolean` | `true` | VWAP line and volume pane. |
| `maxRows` | `number` | `500` | Bars (and fills) read. The exchange keeps 500 closed bars per series (200 engine-local). |

The time axis is a category axis (one slot per bar, no gaps for periods without trades). Fills before the first
loaded bar are not shown.

## DepthChartView

The live book as a stepped cumulative depth chart: bids (green) to the left of the mid and asks (red) to the right,
`cumSize` against `price`, with a dashed mid-price line. It complements `MarketDepth` (exact levels) with the shape of
the book.

```tsx
<DepthChartView />
<DepthChartView ric="VOD.L" showToolbar={false} />
```

Props: `ric`, the link-group props, `showMidPrice` (default `true`), `showToolbar` (default `true`).

## SpreadChart

Book history for one instrument from `bookSamples` (one sample per second, the last 300): the quoted spread in basis
points as a step line with an average mark line, and the touch imbalance (−1 … +1, positive = more bid size) as an
area on a second axis. Props: `ric` and the link-group props.

## PnlHistoryChart

Total, realised and unrealised P&L (USD) for one account over time, from `accountPnlHistory` (one sample per account
every `oms.pnlHistoryIntervalMs`, 10 s). The toolbar has an account selector (`useSelectedAccount`, so it shares the
user's selected account with the rest of the app); pass `account` to control it and hide the selector. A mark line
shows the latest total.

## ExposureTreemap

Open positions from `positionPrices`, grouped by `sector` then `ric`. Tile area is the absolute USD market value
(**Exposure**) or absolute USD total P&L (**P&L**); colour is the sign (long / profit green, short / loss red). Flat
positions are hidden. Click a sector to zoom in; the breadcrumb zooms back out.

The USD columns (`marketValueUsd`, `totalPnlUsd`) are computed by the OMS on `positions`, so London (GBX) and
foreign-currency lines are comparable.

Props: `account`, `measure` / `defaultMeasure` (`"exposure"` | `"pnl"`), `showMeasureSelector` (default `true`).

## SlippageChart

Execution quality: one point per filled parent order (`cumQty > 0`), x = creation time, y = `slippageBps` against the
arrival mid (**positive = worse** than arrival), coloured by side, with mark lines at 0 (arrival) and the average.
Props: `account`, `ric`, `maxRows` (default 1000).

## Theming

- Class bases `tradingPriceChart`, `tradingDepthChartView`, `tradingSpreadChart`, `tradingPnlHistoryChart`,
  `tradingExposureTreemap`, `tradingSlippageChart`; each chart sits in a `tradingChartFrame` (toolbar, body,
  message).
- Up / down colours (candles, volume, fill markers, depth sides, treemap signs) follow `--trading-up` /
  `--trading-down` (see [primitives.md](primitives.md#theming)); the series palette is vuu-chart's
  `--vuuChart-color-1..8`.
- State attributes: `data-interval` (PriceChart), `data-measure` (ExposureTreemap).
- Light / dark follows the Salt mode; vuu-chart reads its colours from the computed CSS when the mode changes.

## Performance

Charts redraw at most once per animation frame per chart, and series animations are disabled (live data would
restart them on every tick). A workspace with the price, depth and spread charts at 4× tick rate is measured in
[performance.md](../performance.md#charts).
