# Large time series: server downsampling

An experiment in charting series far larger than a Vuu table holds: days of 1 s data per instrument (172,800 to
604,800 points per series). A chart has about 1,000 pixel columns, so the server chooses the samples for the
visible window and the chart's width. The client zooms and pans and requests again when the window changes.

The existing chart tables don't fit this. `bookSamples` keeps 300 points per ric, `pnlHistory` 180, `bars` 500
per series, and `trades` about 250 per ric. All of them only fill in real time (see
[charting-data.md](charting-data.md)). So this is a separate store with an RPC, not a bigger table.

Showcase: `#time-series-chart`. Component: [TimeSeriesChart](components/charts.md#timeserieschart).

## Design

```
ExchangeSimulator.flush ──(every timeSeriesIntervalMs)──▶ TimeSeriesStore.sample   live mid / spread per book
first query of a ric ──▶ generateHistory (backwards from the first live point) ──▶ prepended
timeSeries RPC {ric, fields, start, end, points, method, bucketMs?} ──▶ TimeSeriesStore.query
   ──▶ lowerBound(start/end) ──▶ M4 | MinMaxLTTB | LTTB | stride ──▶ gaps ──▶ delta-encoded JSON
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
| `timeSeriesIntervalMs` | 1000 | 1000 | 0 disables the store and the RPC |
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

### Transport

The `timeSeries` RPC is in `trading-schemas/src/rpc/contracts.ts` (`EXCHANGE_QUERY_RPC_NAMES`):

- **Calling it.** It is read-only and any user can call it from any EXCHANGE viewport. The trading server serves
  it through `ExchangeAdminRpcHandler`, without the sim-admin check. The engine-local data serves it through
  `createTradingTestData().rpc`. Both call `handleTimeSeriesRpc`.
- **Params.** They are flat, like the other RPCs: `fields` is comma separated. `bucketMs` re-requests on a known
  bucket grid.
- **Response.** For each field, `t0` plus delta-encoded times `t[]` (whole ms, small numbers in JSON) and values
  `v[]`. A value is rounded to price decimals + 1 for mid and 2 for spread, and `null` marks a gap. The response
  also carries `first` / `last` (the data extent), `now` (the live edge), `bucketMs` and `serverMs`.
- **Edges.** One point either side of the selection is added so the line runs to the window's edges.

### Client (`TimeSeriesChart`, `TimeSeriesController`, `timeSeriesWindow.ts`)

- **ECharts.** It is driven directly (`echarts/core`, the same 6.1.0 that vuu-chart registers). vuu-chart's
  components need a DataSource, and this data comes from an RPC.
- **Zoom and pan.** The x axis spans the whole store, from `first` to now. Wheel and drag move an `inside`
  dataZoom (`rangeMode: value`, `filterMode: weakFilter` so the y axis fits the visible part).
- **When to request** (`needsRequest`). Only when the resolution changes by more than 10%, the method changes, or
  the view leaves the loaded range on a side that has data. The check runs 120 ms after the last zoom or pan
  event (debounced). Panning inside the overscan costs no request.
- **What to request** (`planRequest`):
  - `pixelMs = visible span / plot width`;
  - the window is the visible span plus 50% overscan on each side, not past now, **snapped to the pixel grid**;
  - for M4, `bucketMs = pixelMs` and `points = 4 × columns`, so the buckets are the pixel columns;
  - for LTTB and stride, 2 points per column.

  A newer request supersedes an older one (sequence check).
- **Live edge.** While the view touches now, it follows now. Every store interval, M4 asks for just
  `[start of the last bucket, now]` on the same `bucketMs` and splices it in (`mergeTail`): about 5 points and
  0.3 KB. LTTB buckets are by index and would not line up with a tail, so the other methods reload the window.

## Numbers

### Server: one instrument, a week of 1 s history

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

### Client: showcase, engine-local, 2 days (172,833 points)

Measured in the desktop app's browser pane: Chromium, 1,600 px wide viewport, about 830 px plot.

| View | Request | Server ms | Round trip | Payload |
| --- | --- | --: | --: | --: |
| All (2 days) | M4, 3,189 of 172,897 points, bucket 208 s | 0.6–1.1 | 6–7 ms | 42 KB |
| 1 h | M4, 6,992 of 10,808 (with overscan), bucket 4.3 s | 0.3–0.4 | 11–30 ms | 77 KB |
| 41 min (after wheel zoom) | M4, 3,259 of 3,872, bucket 3 s | 0.1 | 6 ms | 40 KB |
| Live tail, every second | M4, about 5 points | < 0.1 | 8 ms | 0.3 KB |
| All, LTTB / MinMaxLTTB / stride | about 2,490 points | 2.1 / 1.1 / 0.3 | 8–11 ms | 33 KB |

Smoothness was measured with a `requestAnimationFrame` recorder and a long-task observer running while the pane
scrolled to zoom (40 wheel ticks) and dragged to pan in both directions:
- frames: p50 16.7 ms, p95 17.7 ms;
- one frame at 33 ms;
- no long tasks (over 50 ms).

The few frames of about 1 s were rAF pausing between the scripted input batches, not work. Engine-local has no
network; over the websocket, expect the payloads above plus Vuu framing.

## Findings

- **M4 at 4 points per pixel, on a window snapped to the pixel grid, is pixel-exact at constant cost** (about
  0.5 ms for an hour or a week) and is the default. It is also the only method whose buckets are stable when
  panning and at the live edge.
- At the **same number of points**, the LTTB variants look better than M4 (4.4 against 7.2 px error at 1 point per
  pixel). LTTB spends its budget on shape, while M4 at 1 point per pixel has buckets 4 px wide. LTTB still is not
  exact, it is O(n) over the window (3 ms for a week), and it shimmers when panning because its buckets are by
  index.
- **MinMaxLTTB** matches LTTB's look at a third of the cost. It is the choice when payload matters more than exact
  pixels.
- **Payload** is about 13 bytes per point as delta-encoded JSON, and 4 bytes per point gzipped (whether that
  applies depends on websocket compression, not checked here). A typed binary encoding would cut it again (see Open questions).
- **The pyramid** is a 4× win at a week. Below about a day, scanning is fast enough, and `TimeSeries.minMax`
  already scans ranges of 64 points or fewer.
- The **overscan** (50% on each side) means most pans cost no request. Zooming re-requests once the resolution
  is 10% off, which the debounce collapses to one request per gesture.

## Open questions

- **Multiple series.**
  - Fields are downsampled independently, so their sample times differ. That is fine for lines on a time axis,
    and the tooltip shows the nearest point of each.
  - Many series (a sector's 50 instruments) means 50 selections and 50× the payload. Ideas: one shared bucket grid
    with `[first, min, max, last]` per bucket as columns (fixed-width arrays, no times), or an envelope (min/max
    band plus mean) once the series outnumber the pixels.
  - Synchronising several charts' windows (a shared x range) is not done.
- **Gaps.**
  - The store breaks the line where the step is over 3 × interval.
  - A gap narrower than a bucket is not drawn, which matches the full line at that width. If gaps must stay
    visible (a halt), the store should keep them as events.
  - The synthetic history has no market-closed gaps: generation ignores the session schedule, as `barBackfill`
    does. A real feed would want either session-time x axes (closed periods squeezed out) or gaps shown.
- **Step-hold series (P&L, positions).**
  - M4 still works: the first and last of each bucket carry the held value across.
  - The chart must draw them with `step: "end"` (the controller's `stepFields`).
  - Sparse change-only series (as `pnlHistory` writes) would be stored as change points. A bucket with no change
    must then still produce the carried value; today an empty bucket emits nothing, which works for a stepped line
    but not for a bar or area per bucket.
  - LTTB is wrong for steps: its triangle areas assume linear interpolation.
- **Live edge for LTTB.** Index buckets cannot take a tail, so the other methods reload the whole window every
  second (about 2 ms and 33 KB). An alternative is M4 for the last few buckets.
- **Retention.** The store grows by one point per second per field and instrument, without limit. A ring buffer
  needs the pyramid to drop whole top-level blocks. Another way: keep raw data for a day and only the pyramid's
  coarse levels (min/max/first/last per minute) beyond it.
- **Memory.** Each field has its own time array. Sharing one time array per instrument saves 8 bytes per point per
  extra field, and `Float32Array` values would save 4 more (enough precision for display).
- **Binary payload.** A `Float64Array` / `Int32Array` in base64 (or a binary websocket frame) instead of JSON
  numbers. JSON is 13 bytes per point; Int32 time deltas plus Float32 values would be 8 bytes before base64.
- **Persistence.** The store is not persisted: history is regenerated after a restart, as with bars.
- **A Vuu feature?** Requests are RPCs because Vuu viewports are row ranges, not time windows. A "time-window
  viewport" with server-side downsampling, which would also push the live tail, might be worth upstreaming once
  the shape settles.
