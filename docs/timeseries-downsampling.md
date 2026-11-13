# Large time series: server downsampling

An experiment in charting series far larger than a Vuu table holds: days of 1 s data per instrument (172,800 to
604,800 points per series). A chart has about 1,000 pixel columns, so the server chooses the samples for the
visible window and the chart's width. The client zooms and pans, and the data keeps ticking.

The existing chart tables don't fit this. `bookSamples` keeps 300 points per ric, `pnlHistory` 180, `bars` 500
per series, and `trades` about 250 per ric. All of them only fill in real time (see
[charting-data.md](charting-data.md)). So this is a separate store, not a bigger table.

The chart **subscribes** to a series, like a grid subscribes to a table: it opens a viewport and moves a time window
`{start, end, points}` over it, the way a grid sends range changes. The server streams **M4 buckets as rows**: a
pan inserts and deletes the buckets entering and leaving, a tick updates its own bucket. A first version used a
request/response RPC per window; that RPC (`timeSeries`) is kept as a one-shot query for export and benches, and
its numbers are below for comparison.

Showcase: `#time-series-chart`. Component: [TimeSeriesChart](components/charts.md#timeserieschart).

## Design

```
ExchangeSimulator.flush ──(every timeSeriesIntervalMs)──▶ TimeSeriesStore.sample      live mid / spread per book
                                                       └─▶ TimeSeriesBucketPublisher.tick   changed buckets → rows
first use of a ric ──▶ generateHistory (backwards from the first live point) ──▶ prepended

client: CREATE_VP timeSeriesBuckets, filter subId = "<id>"         (any EXCHANGE viewport carries the RPCs)
        setTimeSeriesWindow {subId, ric, fields, start, end, points, follow}   (≈ CHANGE_VP_RANGE)
server: BucketWindow diff ──▶ insert / update / delete rows "subId|field|bucket" ──▶ viewport updates
        closeTimeSeries {subId}, or no window change for TIME_SERIES_LEASE_MS ──▶ rows deleted
```

### Store (`packages/exchange-sim/src/history`)

- **`TimeSeries`** is one growable series: a `Float64Array` of times and one of values (16 bytes per point), plus a
  **min/max pyramid** and the indices of gaps. Appending is O(levels) and keeps the pyramid current.
- **`MinMaxPyramid`**: level *k* holds the index of the min and of the max for each block of `32 << k` points
  (Uint32, about 0.5 bytes per point in all). A range query uses the largest aligned complete blocks, at most two
  per level, plus fewer than 32 raw points at each end. It costs O(32 + log n) however wide the range.
- **`TimeSeriesStore`** keeps per ric a `mid` and a `spreadBps` series. Live points come from every book's touch on
  the flush after each `timeSeriesIntervalMs`, aligned to the interval. A book without a two-sided quote adds
  nothing, which leaves a gap.
- **History is lazy.** The first query of a ric generates `timeSeriesHistoryHours` of 1 s points in front of its
  live points, ending at the first live mid (`historyGen.ts`):
  - mid: the price model's GBM run backwards with its volatility and `timeScale`, as `barBackfill`, plus rare
    jumps so there are single spikes to keep;
  - spread: a log-OU process with occasional blowouts.

  At most `timeSeriesMaxRics` instruments hold history at once. The least recently queried one drops back to its
  live points only.

| Config (`exchangeSim.*`) | Server | Engine-local | |
| --- | --- | --- | --- |
| `timeSeriesIntervalMs` | 1000 | 1000 | 0 disables the store, the subscriptions and the RPCs |
| `timeSeriesHistoryHours` | 168 (604,800 points) | 48 (172,800) | Generated on first query |
| `timeSeriesMaxRics` | 4 | 4 | Instruments holding history at once |

### Downsampling (`downsample.ts`)

Every method works on index ranges of the typed arrays and returns the selected indices in ascending order.

- **M4** (`m4Indices`): time buckets **aligned to multiples of `bucketMs` since the epoch**. Each bucket keeps its
  first, min, max and last point; empty buckets are skipped in one step. With one bucket per pixel column, a 1 px
  line through these points lights exactly the pixels of the full line. Alignment gives two more properties:
  - panning picks the same points for the part of the window that overlaps, so the line doesn't shimmer;
  - at the live edge only the last bucket changes.
- **LTTB** (`lttbIndices`): Largest-Triangle-Three-Buckets over a list of candidate indices. Over the raw range it
  is O(n) in the window.
- **MinMaxLTTB**: min and max per time bucket from the pyramid (`points × 4` candidates), then LTTB down to
  `points`. It looks like LTTB at a fraction of the cost.
- **Stride** (`raw`): every k-th point. This is a baseline, not something to use.
- **Gaps** (`withGaps`): the store records each index where the step is over 3 × interval. Whatever the method,
  the points either side of a gap are added to the selection and a `null` is put between them, so the line breaks.

### Subscription: buckets as rows

**Bucket grid** (`bucketWidthFor`, in trading-schemas so client and server agree). The width is the largest
`interval × 2^k` not wider than `(end − start) / points`: 1 s, 2 s, 4 s … 256 s …. Bucket starts are multiples of
the width since the epoch, like `bars`. So:
- a bucket never moves as the window slides, and a given instant always falls in the same bucket;
- a zoom inside one width level keeps every bucket (only the edges change), and crossing a level resends
  everything, like a re-sort;
- the ladder matches the pyramid's power-of-2 blocks.

**`BucketWindow`** (`history/BucketWindow.ts`) is one subscriber's view, like a viewport over rows keyed by bucket
start. `setWindow(spec)` returns a diff: the buckets leaving the window (removed), the ones entering (computed with
the pyramid, one M4 per bucket), or everything on a width change (`reset`). `tick(now)` slides a `follow` window
to now and recomputes only the buckets holding points appended since the last call (normally the last one),
emitting those whose M4 changed.

**`TimeSeriesBucketPublisher`** (`publish/`) owns the subscriptions and applies each diff to the EXCHANGE table
`timeSeriesBuckets`. There is one row per subscription, field and bucket, keyed `subId|field|bucket`. A row holds
`width`, `count` and the four M4 points (`firstT/first`, `minT/min`, `maxT/max`, `lastT/last`). Values are rounded
to price decimals + 1 for mid and 2 for spread. Rows reach the client through the ordinary viewport machinery, so
the outbound queue coalesces updates per row per publish cycle.

**RPCs** (`EXCHANGE_QUERY_RPC_NAMES`, read-only, any user, from any EXCHANGE viewport; `handleTimeSeriesRpc` on the
trading server and the engine-local data):
- `setTimeSeriesWindow {subId, ric, fields, start, end, points, follow}` opens or moves a subscription. `subId` is
  chosen by the client, so it can open the filtered viewport first. The response carries the bucket width now
  published, the bucket range, the counts of rows sent and removed, the data extent, the server clock and `gapMs`.
  A subscription belongs to the user who opened it; another user cannot move or close it. A change of ric or
  fields replaces it.
- `closeTimeSeries {subId}` deletes its rows. A subscription with no window change for 60 s
  (`TIME_SERIES_LEASE_MS`) is closed too, so the client re-sends its window every 20 s.
- `timeSeries {ric, fields, start, end, points, method}` is the one-shot query (M4, MinMaxLTTB, LTTB or stride,
  delta-encoded JSON), useful for export and the bench.

**Follow mode.** With `follow`, the window is the last `end − start` up to now. Each sample tick slides it on the
server: usually one row update (the open bucket), plus one insert and one delete when a bucket boundary passes.

**Gaps.** Empty buckets are not rows. The client breaks the line where the step from a bucket's `lastT` to the
next bucket's `firstT` is over `gapMs` (3 × interval).

### Client (`TimeSeriesChart`, `TimeSeriesController`, `timeSeriesWindow.ts`)

- **Subscription.** The chart picks a `subId` per instrument and fields, opens a `timeSeriesBuckets` viewport
  filtered on it (`useTradingRows`), and sends window changes through the same viewport. Rows of another width
  (stale, mid-reset) are ignored, so the order of the RPC response and the row updates doesn't matter. On unmount
  it sends `closeTimeSeries`.
- **ECharts.** It is driven directly (`echarts/core`, the same 6.1.0 that vuu-chart registers), because the series
  is built from bucket rows. Each row expands to its first / min / max / last in time order.
- **Zoom and pan.** The x axis spans the whole store, from `first` to now. Wheel and drag move an `inside`
  dataZoom (`rangeMode: value`, `filterMode: weakFilter` so the y axis fits the visible part).
- **Window** (`planWindow`): the visible span plus 50% overscan each side (none past now when following), with
  `points` = one per pixel column of that window. This is the viewport buffer, kept on the client for now.
- **When to send** (`needsWindow`, 120 ms after the last zoom / pan event): the width level changes, `follow`
  changes, or the view leaves the subscribed range on a side that has data. Pans inside the overscan and zooms
  inside a level send nothing.
- **Live edge.** A following view moves with the server clock every second. The window slides on the server,
  so there are no requests, only row updates.

## Numbers

### Subscription, server side

From the same bench script (`BucketWindow` alone, without the table). A week of 1 s mid. The window is the view
plus 50% overscan each side, at one bucket per pixel column (1,200 px view). The 1h and 1d windows are taken in
the middle of the history.

| View | Width | Buckets | setWindow ms | err px, cols (1/px) | err px, cols (2/px) | Pan 10% | Zoom 5% | Zoom out 1.5× |
| --- | --: | --: | --: | --: | --: | --: | --: | --: |
| 1h | 2 s | 3,601 | 0.57 | 0, 0% | 0, 0% | +180 / −180, 0.26 ms | +0 / −90 | +2,701 / −3,511 (reset) |
| 1d | 64 s | 2,701 | 0.87 | 1.92, 60% | 0.92, 43% | +135 / −135, 0.14 ms | +0 / −68 | +1,418 / −0 (same level) |
| 7d | 256 s | 2,364 | 0.84 | 0.78, 39% | 0.37, 24% | 0 (no data beyond) | +0 / −0 | +1,182 / −2,364 (reset) |

- **Ticks.** 200 following 1h subscriptions on one series, one new point a second: 3.2 ms per tick for all of
  them (16 µs each), and 1.5 row changes per subscription per tick (the open bucket, plus an insert and delete as
  a bucket boundary passes).
- **Row size.** A bucket row is about 158 bytes as JSON values (15 columns: key, subId, ric, field, 4 times, 4
  values …). That is about 40 bytes per point, against about 13 for the one-shot RPC's delta encoding. Vuu's
  framing adds more.
- **Error.** Buckets on the 2^k ladder don't line up with pixel columns, so the line is no longer pixel-exact as
  the snapped one-shot M4 is: up to about 2 px in some columns at one bucket per pixel, under 1 px at two. At 1 s
  data and small spans every point is kept, so it is exact.

### Subscription, in the browser (showcase, engine-local, 2 days = 172,800 points)

Chromium in the desktop app's browser pane, 1,600 px viewport, about 830 px plot.

| Action | Buckets | Rows sent / removed | Server ms | Round trip |
| --- | --: | --: | --: | --: |
| Open, 1 h following (history generated on first use) | 1,351 | +1,351 | 23.6 (2.8 for the second chart) | 38 ms |
| "All" (2 days, a new level: 128 s) | 1,351 | +1,351 / −1,351 | 3.8 | 6 ms |
| Wheel zoom inside the level | 1,351 | 0 / 0 | 0.1 | |
| Pan by about 0.7 of the view, past the overscan (1 h, 4 s buckets) | 1,801 | +650 / −650 | 0.5–0.9 | 1–2 ms |
| Live, every second | | 1–2 row updates | | |

Six pans with window changes in a row (453 frames): p50 16.7 ms, p95 17.6 ms, max 17.7 ms, no long tasks. Wheel
zooming and the follow mode were also free of frames over 33 ms.

### One-shot RPC, server: one instrument, a week of 1 s history

From `bun packages/exchange-sim/scripts/timeseriesBench.ts` on an Apple-silicon laptop (Bun 1.3). There are
604,800 points per field and 2 fields. The window is 1,200 × 400 px, snapped to the pixel grid. Each figure is the
median of 20 runs, including `JSON.stringify`.

**Visual error.** Both lines are rasterized into the same canvas. *err px* is the mean difference, in pixel rows,
of each column's lit extent. *cols* is the share of columns that differ at all.

| Window | Method | Points asked | Source points | Returned | Server ms | JSON KB | gzip KB | err px | cols |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: |
| 1h | m4 | 4,800 | 3,600 | 2,956 | 0.29 | 36.2 | 5.6 | **0** | 0% |
| 1d | m4 | 1,200 | 86,400 | 1,179 | 0.18 | 15.7 | 4.7 | 9.43 | 96% |
| 1d | minmaxlttb | 1,200 | 86,400 | 1,202 | 0.82 | 16.2 | 4.9 | 6.00 | 90% |
| 1d | lttb | 1,200 | 86,400 | 1,202 | 1.30 | 16.2 | 4.9 | 5.99 | 90% |
| 1d | stride | 1,200 | 86,400 | 1,202 | 0.09 | 16.0 | 3.1 | 9.27 | 98% |
| 1d | **m4** | 4,800 | 86,400 | 4,515 | **0.50** | 57.6 | 14.4 | **0** | 0% |
| 1d | minmaxlttb | 4,800 | 86,400 | 4,802 | 2.15 | 62.7 | 15.6 | 1.23 | 52% |
| 1d | lttb | 4,800 | 86,400 | 4,802 | 1.69 | 62.7 | 15.6 | 1.27 | 56% |
| 1d | stride | 4,800 | 86,400 | 4,802 | 0.27 | 63.2 | 10.6 | 4.83 | 97% |
| 7d | m4 | 1,200 | 604,641 | 1,192 | 0.18 | 16.5 | 5.4 | 7.24 | 96% |
| 7d | minmaxlttb | 1,200 | 604,641 | 1,201 | 0.63 | 17.2 | 5.8 | 4.36 | 87% |
| 7d | lttb | 1,200 | 604,641 | 1,201 | 2.88 | 17.2 | 5.8 | 4.35 | 89% |
| 7d | **m4** | 4,800 | 604,641 | 4,701 | **0.54** | 62.7 | 18.2 | **0** | 0% |
| 7d | minmaxlttb | 4,800 | 604,641 | 4,801 | 2.07 | 66.4 | 19.5 | 0.97 | 50% |
| 7d | lttb | 4,800 | 604,641 | 4,801 | 3.27 | 66.5 | 19.7 | 0.97 | 52% |
| 7d | stride | 4,800 | 604,641 | 4,800 | 0.25 | 67.9 | 12.0 | 4.55 | 99% |

What the pyramid buys, for M4 over a 7 day window: 0.24 ms against 0.99 ms when every point is scanned. The gap
grows with the store; scanning is O(n) and the pyramid is not.

**Memory.**
- Store: 20.6 bytes per point. That is 16 for the time and value, 0.6 for the pyramid, and the rest is growth
  headroom.
- Per instrument, a week of 2 fields takes 24.9 MB; heap grew by 27.7 MB.
- Generating the history takes 70 ms.
- Server worst case with the defaults (4 rics × 7 days): about 100 MB. Engine-local (4 × 2 days): about 28 MB.
- Live points for every other instrument: about 32 bytes per second per instrument (86,400 per day each).

### One-shot RPC, in the browser (first version of the chart, engine-local, 2 days)

Measured in the desktop app's browser pane: Chromium, 1,600 px wide viewport, about 830 px plot.

| View | Request | Server ms | Round trip | Payload |
| --- | --- | --: | --: | --: |
| All (2 days) | M4, 3,189 of 172,897 points, bucket 208 s | 0.6–1.1 | 6–7 ms | 42 KB |
| 1 h | M4, 6,992 of 10,808 (with overscan), bucket 4.3 s | 0.3–0.4 | 11–30 ms | 77 KB |
| 41 min (after wheel zoom) | M4, 3,259 of 3,872, bucket 3 s | 0.1 | 6 ms | 40 KB |
| Live tail, every second (a request for the last bucket) | M4, about 5 points | < 0.1 | 8 ms | 0.3 KB |
| All, LTTB / MinMaxLTTB / stride | about 2,490 points | 2.1 / 1.1 / 0.3 | 8–11 ms | 33 KB |

Smoothness was measured with a `requestAnimationFrame` recorder and a long-task observer running while the pane
scrolled to zoom (40 wheel ticks) and dragged to pan in both directions:
- frames: p50 16.7 ms, p95 17.7 ms;
- one frame at 33 ms;
- no long tasks (over 50 ms).

The few frames of about 1 s were rAF pausing between the scripted input batches, not work. Engine-local has no
network; over the websocket, expect the payloads above plus Vuu framing.

## Findings

- **The subscription fits.** Buckets on a clock-aligned 2^k grid behave like rows:
  - a pan costs only the buckets entering and leaving the window (10% of the window for a 10% pan, 0.1–0.3 ms);
  - a zoom inside a width level costs nothing, or only the edges;
  - a tick updates one or two rows per subscriber at about 16 µs each.

  Live data needs no polling and no tail requests, and the client code is simpler than the RPC version (no
  request sequencing or merging).
- **M4 is the method for live data.** It is local to its bucket, so a tick changes only that bucket. LTTB picks
  each point from its neighbours, so a tick could change points already sent; it stays in the one-shot query.
- **Exactness against stability.** The fixed ladder gives up pixel-exactness: about 2 px in some columns at one
  bucket per pixel, under 1 px at two. Ways back: two buckets per pixel (twice the rows); quantise the chart's zoom
  so a pixel is exactly one ladder width; or snap the x axis scale to the ladder. The one-shot M4, snapped to the
  pixel grid, stays exact.
- **Row overhead.** About 158 bytes per bucket row as JSON values, against about 13 bytes per point delta-encoded:
  roughly 3× more on the wire for the same picture. It barely matters for one chart (a pan is about 650 rows, a
  tick 1–2), but a protocol extension should send buckets as compact typed tuples (below).
- **One-shot M4** is still the cheapest way to get a static, pixel-exact picture (0.5 ms, about 60 KB for any
  span). It suits export, and a first paint before the subscription fills.
- At the **same number of points** in the one-shot query, the LTTB variants look better than M4 (4.4 against
  7.2 px error at 1 point per pixel). They are O(n) over the window and shimmer when panning; MinMaxLTTB matches
  LTTB's look at a third of the cost.
- **The pyramid** is a 4× win for a week-wide M4 (0.24 against 0.99 ms). Below a day, scanning is fast enough.

## As a Vuu protocol extension

The prototype rides on existing Vuu pieces: a shared table with rows filtered per subscription, and RPCs as the
range change. A proper extension would be:

- **A time-window range on a viewport.** `CREATE_VP` on a time-series table (`ric`, `field` as the "filter"), and
  `CHANGE_VP_RANGE` with `{ type: "time", start, end, points, follow }` instead of `{from, to}`. The server keeps
  a BucketWindow per viewport and answers with the width chosen. Overscan becomes the viewport's buffer
  (server-side, as for rows), and the lease becomes the viewport's lifetime: no subId, no keep-alive, no
  `closeTimeSeries`.
- **Rows as compact tuples.** `TABLE_ROW` updates keyed by bucket start, carrying `[bucket, count, firstT, first,
  minT, min, maxT, max, lastT, last]` with times as offsets from the bucket. Or a dedicated message
  (`TIME_SERIES_UPDATE {vpId, width, upserts: [...], removed: [...]}`) with columnar arrays, which would also suit
  a binary frame.
- **Size and selection** keep their meaning: size is the bucket count in the window; selection could be a time.
- **Server side** (`@heswell/vuu-server`): a TimeSeriesProvider interface (series lookup, append notifications)
  and the viewport type. The table/viewport publish queue already coalesces by row key, which is exactly the
  merge a bucket tick needs.
- **Client side** (vuu-ui): a `TimeSeriesDataSource` with `setWindow()` in place of `setRange()`. vuu-chart could
  then feed a line chart from it like any other DataSource.

## Open questions

- **Multiple series.**
  - Fields are downsampled independently, so their sample times differ. That is fine for lines on a time axis,
    and the tooltip shows the nearest point of each.
  - Many series (a sector's 50 instruments) means 50 BucketWindows and 50× the rows. With one shared grid,
    every series' buckets have the same keys, so a row could hold one column group per series (a wide row per
    bucket). Or an envelope (min/max band plus mean) once the series outnumber the pixels.
  - Synchronising several charts' windows (a shared x range) is not done.
- **Gaps.**
  - The store breaks the line where the step is over 3 × interval.
  - A gap narrower than a bucket is not drawn, which matches the full line at that width. If gaps must stay
    visible (a halt), the store should keep them as events.
  - The synthetic history has no market-closed gaps: generation ignores the session schedule, as `barBackfill`
    does. A real feed would want either session-time x axes (closed periods squeezed out) or gaps shown.
- **Step-hold series (P&L, positions).**
  - M4 still works: the first and last of each bucket carry the held value across.
  - The chart must draw them with `step: "end"` (the controller's `stepFields`). It would also need the last
    point before the window, to carry the value into the first bucket.
  - Sparse change-only series (as `pnlHistory` writes) would be stored as change points. A bucket with no change
    must then still produce the carried value; today an empty bucket emits nothing, which works for a stepped line
    but not for a bar or area per bucket.
  - LTTB is wrong for steps: its triangle areas assume linear interpolation.
- **Filtering cost of the shared table.** Every `timeSeriesBuckets` viewport filters the whole table, and each
  row update is checked against every subscription's filter: O(subscriptions × updates). This is fine for a demo.
  A real version needs per-subscription row sets, which is what a viewport-level time range would give.
- **Lifecycle.** The prototype ties a subscription to a client-chosen `subId` with a 60 s lease. The server cannot
  see the viewport close, so a closed tab leaves its rows for up to a minute.
- **Exact pixels on the ladder.** See Findings: either 2 buckets per pixel, or zoom quantised to ladder widths.
- **History arriving after a subscription.** Generating history (first use) swaps the series, which resets the
  window: all of its rows are resent. A real store backfilling data would want a "range changed" diff instead.
- **LTTB live.** Not supported by the subscription. If it is wanted, a likely route is: LTTB over closed buckets
  only, with M4 for the open bucket.
- **Retention.** The store grows by one point per second per field and instrument, without limit. A ring buffer
  needs the pyramid to drop whole top-level blocks. Another way: keep raw data for a day and only the pyramid's
  coarse levels (min/max/first/last per minute) beyond it.
- **Memory.** Each field has its own time array. Sharing one time array per instrument saves 8 bytes per point per
  extra field, and `Float32Array` values would save 4 more (enough precision for display).
- **Binary payload.** Bucket tuples as typed arrays in base64 (or a binary websocket frame) instead of JSON
  rows: about 158 bytes per bucket now; Int32 time offsets plus Float32 values would be about 40.
- **Persistence.** The store is not persisted: history is regenerated after a restart, as with bars.
