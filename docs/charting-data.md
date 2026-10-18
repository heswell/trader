# Chart data

The exchange simulator and the OMS publish tables meant for charts. They are ordinary Vuu tables: subscribe with a
viewport, sort, filter (for example `ric = "AAPL.OQ" and interval = "1m"`) and get live updates. The engine-local
data (`createTradingTestData`) has the same tables, so showcase and tests see the same data as the server.

Schemas are in `@heswell/trading-schemas` (`bars`, `bookSamples`, `pnlHistory`, `accountPnlHistory`; key helpers
`barKey`, `bookSampleKey`, `pnlHistoryKey`, `accountPnlHistoryKey`, `parseBarInterval`). See the
[API reference](api/trading-schemas.md).

| Table | Module | Key | Rows | Updates |
| --- | --- | --- | --- | --- |
| `bars` | EXCHANGE | `ric\|interval\|start` | `barHistory` closed bars + the current bar, per ric and interval | Current bar in place every publish cycle; closed bars are final |
| `bookSamples` | EXCHANGE | `ric\|time` | `bookSampleHistory` per ric | Insert every `bookSampleIntervalMs`, oldest deleted |
| `pnlHistory` | OMS | `account\|ric\|time` | up to `pnlHistoryLength` per position | Insert when a position changed, every `pnlHistoryIntervalMs` |
| `accountPnlHistory` | OMS | `account\|time` | `pnlHistoryLength` per account | Insert every `pnlHistoryIntervalMs` |
| `parentOrders` | OMS | `orderId` | | New execution-quality columns |

Existing tables that are useful for charts: `depth` (live ladder), `trades` (time and sales), `fills` (the user's
executions), `positionPrices` (positions with live prices, sector and currency).

## `bars`: OHLCV candles

One row per instrument, interval and bar start, built from every exchange trade of every simulated instrument.

| Column | |
| --- | --- |
| `ric`, `interval` | `interval` is a label from `exchangeSim.barIntervals`: `<n>s`, `<n>m`, `<n>h` or `<n>d` |
| `start`, `end` | Epoch ms. `start` is aligned to the interval (multiples of it since the epoch); `end = start + interval`, exclusive |
| `open`, `high`, `low`, `close` | Trade prices |
| `volume`, `turnover`, `trades` | Sum of sizes, sum of size × price, trade count |
| `vwap` | `turnover / volume`, rounded to the price decimals + 2 |
| `closed` | `false` for the bar still being built |
| `backfilled` | `true` for synthetic startup history |

**Clock.** Intervals are exchange-clock (wall) time. `exchangeSim.timeScale` (default 10) only speeds up the price
model, so a 1m candle carries about 10 simulated minutes of volatility. That keeps the candles lively in a short
demo while their timestamps line up with the trades and fills tables and with the user's clock. Trading session
phases don't change the bar clock; with no trades (closed, halted or quiet book) there are no bars.

**Updates.** A trade opens a bar for each interval if none is open, or updates the open one. Updates are coalesced:
the current bar is written once per publish cycle (`publishIntervalMs`, 100 ms), not once per trade. A bar closes
when a later trade falls into a new interval or when a publish cycle runs after its `end`; its row is then updated
once more with `closed = true` and never changes again.

**No-trade intervals are gaps.** No row is created for an interval without trades (no carry-forward bar with zero
volume). Charts should use a time axis (ECharts `type: "time"`) or fill gaps client-side; a category axis would
squeeze out the gaps.

**Rolling window.** Each ric and interval keeps `barHistory` (500) closed bars plus the open one; the oldest row is
deleted. Server defaults: 200 instruments × 3 intervals × 500 = 300k rows at most. The engine-local data keeps 200
per series.

**Backfill.** With `barBackfill=1` (default, server and engine-local), each series starts with `barHistory`
synthetic closed bars ending at the current interval, generated backwards from the current price by the price
model (same volatility and `timeScale`, inside the price band, on tick) with volume from the taker rate. They are
flagged `backfilled`. Intervals are generated independently, so 1m and 5m backfill don't aggregate into each
other, and backfill ignores the session schedule. Some backfilled intervals have no trades and are gaps, like live
bars. Backfill uses its own RNG: live trading is the same with backfill on or off.

**Not persisted.** After a restart the bars are rebuilt (re-backfilled, then live). See
[persistence.md](persistence.md#limits).

## `bookSamples`: book history

Every `bookSampleIntervalMs` (1000 ms; 0 disables) each instrument's published book is sampled, from the levels
last published to the `depth` table (no extra book queries). `time` is aligned to the interval. A book with both
sides empty is skipped. `bookSampleHistory` (300, 5 minutes) samples are kept per instrument.

| Column | |
| --- | --- |
| `bid`, `ask`, `mid` | Touch prices; `mid` (and `spreadBps`) empty when a side is empty |
| `spreadBps` | `10000 × (ask − bid) / mid` |
| `bidSize`, `askSize` | Size at the touch |
| `bidDepth`, `askDepth` | Cumulative size of the top 5 levels |
| `imbalance` | `(bidDepth − askDepth) / (bidDepth + askDepth)`, −1…1, positive = bid heavy |
| `bidPx0..4`, `bidSz0..4`, `askPx0..4`, `askSz0..4` | Top 5 levels (0 = touch); empty price / 0 size when the book is thinner |

## `pnlHistory` and `accountPnlHistory`

The OMS mark timer (`markIntervalMs`, 500 ms) marks positions and, every `pnlHistoryIntervalMs` (10 s; 0
disables), samples them. `time` is aligned to the interval.

- `pnlHistory` (`account|ric|time`): `quantity`, `avgCost`, `markPx`, `marketValue`, `realizedPnl`,
  `unrealizedPnl`, `totalPnl`, `grossExposure` (|marketValue|), `netExposure` (signed) in the instrument currency
  (`currency`; London lines are GBX), plus `totalPnlUsd` and `marketValueUsd`. A row is written only when the
  position's quantity, mark or realised P&L changed since its last row, so a flat, unmarked position adds nothing;
  charts should step-hold the previous value.
- `accountPnlHistory` (`account|time`): one row per account every sample, in USD. `positions` (non-zero
  quantity), `realizedPnl`, `unrealizedPnl`, `totalPnl`, `grossExposure`, `netExposure`.
- Rolling window: `pnlHistoryLength` (180, 30 minutes) rows per position / account; the oldest are deleted.
- Permissions: both tables have the same account filter as `positions` (a user sees only their accounts).
- Not persisted; history starts empty after a restart.

## Execution quality on `parentOrders`

| Column | |
| --- | --- |
| `arrivalPrice` | Mid at order creation; the reference price (last, else refPrice) when the book has no two-sided quote |
| `slippageBps` | avgPx vs arrival, **positive = worse**: buy `(avgPx − arrival) / arrival × 10⁴`, sell `(arrival − avgPx) / arrival × 10⁴`. 0 until filled |
| `timeToFirstFill` | ms from `created` to the first fill; 0 until filled (check `cumQty`) |
| `timeToComplete` | ms from `created` to `FILLED`; 0 otherwise (cancelled / expired orders stay 0) |

Times use the OMS clock. The fields are part of the order snapshot and survive a restart.

## Suggested charts

- **Candlestick + volume + VWAP.** `bars` filtered by `ric` and `interval`, sorted by `start`: candles from
  open/high/low/close, a volume bar series (colour by close ≥ open) and a VWAP line. Session VWAP is `vwap` on the
  `prices` row.
- **Fills as markers.** `fills` filtered by `ric` (and the user's account, automatic with permissions): a scatter
  series at (`timestamp`, `price`), buy / sell symbols, size by `quantity`. Markers line up with the candles because
  both use the exchange clock.
- **Live depth chart.** `depth` filtered by `ric`: stepped area of `cumSize` against `price`, bids and asks mirrored
  around the mid.
- **Depth heatmap.** `bookSamples` filtered by `ric`: x = `time`, y = `bidPx*/askPx*`, colour = `bidSz*/askSz*`.
- **Spread and imbalance.** `bookSamples`: `spreadBps` line, `imbalance` area around 0; touch sizes as bars.
- **P&L curves.** `accountPnlHistory` per account (`totalPnl`, realised vs unrealised stacked), `pnlHistory` per
  position (`totalPnlUsd`); exposure lines from `grossExposure` / `netExposure`.
- **Slippage scatter.** `parentOrders` with `cumQty > 0`: x = `notional` or `quantity`, y = `slippageBps`, colour by
  side or `ordType`; `timeToFirstFill` / `timeToComplete` histograms.
- **Exposure treemap.** `positionPrices` grouped by `sector` → `ric`, area = |`marketValue`| (convert to USD per
  currency), colour = `totalPnl` or side.

## Configuration

| Key | Default | |
| --- | --- | --- |
| `exchangeSim.barIntervals` | `1s,1m,5m` | Bar intervals; empty disables `bars` |
| `exchangeSim.barHistory` | 500 (engine-local 200) | Closed bars per ric and interval |
| `exchangeSim.barBackfill` | 1 | Seed synthetic history at startup |
| `exchangeSim.bookSampleIntervalMs` | 1000 | 0 disables `bookSamples` |
| `exchangeSim.bookSampleHistory` | 300 | Samples per ric |
| `oms.pnlHistoryIntervalMs` | 10000 | 0 disables P&L history |
| `oms.pnlHistoryLength` | 180 | Samples per position / account |

Env vars: `EXCHANGE_SIM_BAR_INTERVALS`, `OMS_PNL_HISTORY_INTERVAL_MS`, and so on.

## Cost

See [performance.md](performance.md#chart-data).
