# Performance

Performance tooling lives in `packages/perf` (`@heswell/trading-perf`, private). It has three tools:

| Script | What it measures | Needs | CI |
| --- | --- | --- | --- |
| `bun run perf:ws` | End-to-end WS throughput: N headless Vuu clients × M viewports on ticking tables | Bun only (local target) or `start:all` (stack target) | smoke preset, `--assert` |
| `bun run perf:ui` | UI tick-rate profile of a showcase scenario in headless Chrome | Chrome | no (opt-in) |
| `bun run perf:ladder` | Depth-ladder frame budget (p95 render / update→commit < 16 ms) | Chrome | no (opt-in) |

All tools write `perf-results/<tool>-<stamp>.{json,md}` (git-ignored) and print the markdown summary.

In CI, the Chrome tools are replaced by `packages/trading-ui/__tests__/renderStability.test.tsx`, which runs in `test:ui` with happy-dom. It checks that the ladder toolbar and link-group selectors are not re-rendered by price or depth ticks.

## WS load harness (`perf:ws`)

```sh
bun run perf:ws                      # smoke: 5 clients x 5 viewports, 10s (+3s warm-up), tick x1
bun run perf:ws --preset=heavy       # 50 clients x 8 viewports, 30s (+5s), tick x4
bun run perf:ws --clients=20 --viewports=6 --tick=2 --duration=20
bun run perf:ws --target=stack       # against a running `bun run start:all`
```

| Flag | Default (smoke / heavy) | Meaning |
| --- | --- | --- |
| `--preset` | `smoke` | `smoke` or `heavy` |
| `--target` | `local` | `local` spawns `packages/perf/src/perf-server.ts`: the trading server with `application.perf.conf` (permissive auth, free ports, `maxSessionsPerUser` lifted), stats on. `stack` uses the `start:all` ports (`TRADER_*` env, `scripts/stack/config.ts`) and logs in through Keycloak. |
| `--clients`, `--viewports` | 5, 5 / 50, 8 | N sessions × M viewports each |
| `--duration`, `--warmup` | 10, 3 / 30, 5 | Measured window and warm-up, in seconds |
| `--tick` | 1 / 4 | Multiplier on the simulator bot rates (market maker 10/s, taker 8/s) |
| `--mm-rate`, `--taker-rate`, `--publish-ms`, `--active` | from `--tick` | Override the simulator rates, the price publish throttle, and the number of active instruments (local target only) |
| `--book-l3` | off | `snapshot`, `events` or `forward`: with each ladder viewport, also open the L3 viewports an order book opens on its ric (`useBookQueue`): `bookOrders` (2,000 rows), plus `bookStatus` and a `bookEvents` window for `events` (newest first, as before forward reading) and `forward` (`seq > N` ascending, as `useBookQueue` reads it now). Both turn the tape on (`EXCHANGE_SIM_BOOK_EVENTS=1`). |
| `--event-window` | 100 / 500 (`forward`) | `bookEvents` rows per viewport (`useBookQueue`'s `eventWindow`) |
| `--advance-ms` | 1000 | `forward`: longest time before N moves on (it also moves once half the window has arrived) |
| `--event-sort` | `asc` | `forward`: `none` drops the sort and relies on insertion order |
| `--workers` | CPUs − 2 | Client worker threads (Bun workers, so the harness is not the bottleneck) |
| `--assert` | off | Exit 1 on client errors or disconnects, no rows on a ticking table, or an e2e p95 over `--max-p95-ms` (default 1000) |

Viewport kinds are cycled per client, so a run mixes all ticking tables:
- EXCHANGE: `instrumentPrices`, `prices`, `depth` (the ladder), `trades`
- OMS: `parentOrders`, `childOrders`, `positionPrices`, `fills`

On the stack target, sessions are spread over the trading users (alice, bob, carol, erin, sam, dave) to stay within `maxSessionsPerUser=5` / `reject-new`. More than 30 clients needs the local target.

### Metrics

- **Client rows/s, bytes/s**: TABLE_ROW rows and frame bytes received in the measured window, total and per table kind.
- **E2E latency**: receipt time minus a publish timestamp:
  - `instrumentPrices` / `prices` / `depth`: the row's `lastUpdate` (wall clock at publish in the simulator);
  - orders: `lastUpdate`;
  - trades: `time`.
  The tables report p50 / p95 / p99 / max. **Wire latency** is receipt time minus the server's TABLE_ROW batch `timeStamp`.
- **Server** (local target): `PerfStatsReporter` (`packages/oms/src/perf`) is enabled by `TRADER_PERF_STATS_FILE`. It appends one line per [metrics](metrics.md) snapshot (once a second) to a JSONL file, from the same collector as the METRICS tables:
  - CPU user and system time, RSS, heap;
  - event-loop lag, p99 and max;
  - order-book events, trades, price and depth updates;
  - OMS table writes.
  The harness also samples `ps` CPU% and RSS for the server PID. Since vuu-server 4.5.0 the server's own session, queue and send-cycle metrics are in
  the METRICS tables (the `vuu` metrics and `metricsSessions` in [metrics.md](metrics.md)).
- **Coalescing**:
  - *publisher*: 1 − price/depth table updates ÷ order-book events. These are book changes merged by the `publishMs` throttle before they reach the tables.
  - *server→client*: 1 − client rows received ÷ (server table writes × subscribers), estimated per table kind. vuu-server keeps only the latest row per key between its 60 ms send cycles (trader upstream issue 92).

## UI profile (`perf:ui`)

```sh
bun run perf:ui                                      # trader-workspace, remote data, tick x4, 15s
bun run perf:ui --scenario=price-ladder-live --throttle=4 --cpu-profile
bun run perf:ui --data=local --tick=1
```

How it works:
1. Builds the showcase with `SHOWCASE_PROFILING=1` into `perf-results/.showcase`. That build uses `react-dom/profiling` and keeps function names. Pass `--reuse-build` to skip the build.
2. Serves the build on a free port.
3. With `--data=remote` (the default), starts a perf server. The page connects through `?data=remote&ws=…&auth=…`.
4. Opens `#<scenario>` in headless Chrome (playwright, using system Chrome or `CHROME_PATH`).
5. For `trader-workspace`, picks the green link-group instrument so the ladder, depth and tape tick.
6. After `--warmup` seconds, records for `--duration` seconds.

Metrics recorded:
- FPS, frame-interval percentiles and dropped frames (rAF);
- long tasks and long animation frames (PerformanceObserver);
- CDP `Performance.getMetrics` deltas: scripting, layout, style-recalc and task ms per second, layouts/s;
- DOM mutations per second and JS heap;
- page errors.

`--cpu-profile` also saves a `.cpuprofile` and lists the top self-time functions.

The showcase reads these URL parameters:
- `?data=remote|local`;
- `?mmRate=`, `?takerRate=`, `?publishMs=`, `?active=` (local simulator rates);
- `?ws=` / `?auth=` (remote endpoints, overriding the build-time defines).

Headless Chrome on a developer laptop has CPU to spare, so use `--throttle=4` (CDP CPU throttling) to make differences show.

## Ladder frame budget (`perf:ladder`)

```sh
bun run perf:ladder                                  # rates 50,100,200 updates/s, 10s each, budget 16ms
bun run perf:ladder --throttle=4 --assert
```

The tool opens the showcase's `#price-ladder-stress` example with `?rate=R&autorun=1&seconds=S`. The example updates a synthetic book R times a second, with a `<Profiler>` around a `PriceLadderView`, and reports:
- **render**: React commit `actualDuration`. avg, p95 and max over the run, excluding the first second.
- **update→commit**: book update to `useLayoutEffect`, p95 and max.
- **update→frame**: book update to the next animation frame, p95 of the worst 1-second window.
- page FPS and long frames (frames over 16.7 ms).

A rate **fails** if render p95 or update→commit p95 is over `--budget` (16 ms). Long frames are always reported. They only fail the check when `--max-dropped-pct` is given, because page FPS on a loaded machine reflects the machine, not the ladder. `--assert` exits 1 on any failure.

The check is opt-in: it needs Chrome and its timings depend on the machine.

## Baselines

These baselines were measured on 2026-10-15 on macOS, 8 CPUs, Bun 1.3.14 and Chrome 141. The machine was shared, with a load average of about 5–6, so FPS figures are noisy. Repeat runs and compare like with like.

### WS throughput (local target)

| | smoke (5 × 5, tick ×1) | heavy (50 × 8, tick ×4) |
| --- | --- | --- |
| client rows/s | ~7,000 | 142,900 |
| client MB/s | ~2.0 | 40.5 |
| e2e latency prices p50 / p95 / p99 ms | 36 / 65 / – | 54 / 85 / 114 |
| e2e latency orders p95 ms | – | 107 |
| e2e latency trades p95 ms | 98 | 120 |
| wire latency p95 ms | 1 | – |
| server CPU (ps) | ~44% | 83% |
| server RSS | ~240 MB | 601 MB |
| server event-loop lag p99 | ~8–10 ms | 38.5 ms |
| coalescing: publisher / server→client | 88.6% / ≈0–2% | 94.9% / 3.3% |
| errors / disconnects | 0 / 0 | 0 / 0 |

How to read these numbers:
- E2E latency is dominated by vuu-server's fixed 60 ms session send cycle (≈ 30 ms average wait) plus the simulator's publish throttle.
- At heavy load, the server's event loop starts to lag. One process serves all 400 viewports at 83% CPU.

### UI profile: `trader-workspace`

The fixed numbers are from runs after the hot-spot fixes below.

| data, tick, CPU throttle | FPS | long tasks / 15 s | scripting ms/s |
| --- | --- | --- | --- |
| local, ×1, ×1 | 60 | 0 | 104 |
| remote, ×4, ×1 | 60 | 0 | 57 |
| local, ×4, ×4 | 27 | 26 | 386 |
| remote, ×4, ×4 | 21–23 | 40–53 | 245–257 |

Without throttling, the workspace holds 60 FPS at 4× the default tick rate. Under a 4× CPU throttle, most main-thread time is native rendering: style recalculation, layout and paint, with about 3,000 DOM mutations/s.

### Ladder frame budget

| CPU throttle | rate/s | render p95 ms | update→commit p95 ms | result |
| --- | --- | --- | --- | --- |
| ×1 | 50 / 100 / 200 | 0.6–0.7 | 1.2–1.8 | pass (60 FPS) |
| ×4 | 50 / 100 / 200 | 1.7 / 1.6 / 1.4 | 4.2 / 4.7 / 7.4 | pass |

The ladder is well inside its budget: a 200 updates/s book costs under 2 ms per React commit, even at 4× throttle.

## Chart data

The chart tables ([charting-data.md](charting-data.md)) were measured on 2026-10-18 on the same shared machine
(load average 3–5). The `perf:ws` smoke (local target, 336 active rics) was run back to back with the defaults and
with chart data off (`EXCHANGE_SIM_BAR_INTERVALS= EXCHANGE_SIM_BOOK_SAMPLE_INTERVAL_MS=0
OMS_PNL_HISTORY_INTERVAL_MS=0`):

| smoke, 336 rics | chart data off | defaults (on) |
| --- | --- | --- |
| client rows/s | 10,963 | 10,792 |
| e2e prices p95 / trades p95 ms | 64 / 97 | 64 / 108 |
| server CPU (stats file) | 49.5% | 47.5% |
| server heap max / RSS max | 282 MB / 641 MB | 545 MB / 922 MB |
| event-loop lag p99 | 5.2 ms | 14.2 ms |

- **CPU and throughput** don't change measurably. Bars are updated per trade in memory and written once per
  publish cycle (one row update per active series), and book samples reuse the levels already published to
  `depth`.
- **Memory** is the cost, almost all from the `bars` rolling window: 3 intervals × (`barHistory` 500 + 1) rows
  per ric, about 0.5 KB of heap per row through vuu-server's table. With backfill that's paid at startup: about
  300k rows with the server default of 200 rics (a fully grown window without backfill is the same). Book samples
  add up to `bookSampleHistory` (300) × rics rows (60k at 200 rics) and P&L history at most `pnlHistoryLength`
  (180) × positions.
- **Startup**: backfilling 200 rics × 3 intervals × 500 bars takes about 1.4 s before the server listens
  (~130 MB of engine heap).
- The higher event-loop lag p99 comes from GC on the larger heap.
- In `start:all` (200 rics, background OMS flow) the trading server was at ~945 MB RSS after 90 s.

To trim: lower `exchangeSim.barHistory`, drop `1s` from `barIntervals`, or set `barBackfill=0` (the window then
fills only as trades arrive).

## Book event tape

The `bookEvents` tape (`exchangeSim.bookEvents`, [exchange-sim README](../packages/exchange-sim/README.md)) was
measured on 2026-11-24 (macOS, 8 CPUs, load average about 1.8) to decide whether to turn it on by default. Each
order book in event mode (`useOrderBook`, `useBookQueue({ events: true })`) opens three L3 viewports on its ric:
`bookOrders`, `bookStatus` and a 100-row seq-desc `bookEvents` window. `--book-l3` adds the same viewports per
ladder viewport.

Writing the tape is cheap: the simulator bench (`--mode=max`, 200 books) needs 3–5% more wall time with it, although
table updates go from 40k to 73k per simulated second. The harness runs, single runs for heavy (30 s):

| | smoke, snapshot | smoke, events | heavy, snapshot | heavy, events | heavy, events, window 25 |
| --- | --- | --- | --- | --- | --- |
| order books (L3 viewport sets) | 4 | 4 | 120 | 120 | 120 |
| server CPU (stats file) | 57.5% | 60.8% | 116% | 125% | 124% |
| event-loop lag p99 | 5–31 ms | 7 ms | 56 ms | 82 ms | 88 ms |
| server RSS max | 731–963 MB | 757–786 MB | 1,332 MB | 1,656 MB | 1,478 MB |
| `bookEvents` rows/s per viewport | – | 895 | – | 345 | 92 |
| prices rows/s delivered | ~7,950 | ~7,990 | 95,519 | 60,806 | 72,186 |
| trades rows/s delivered | ~6,100 | ~6,140 | 33,906 | 24,212 | 27,449 |
| ladder rows/s delivered | 244 | 240 | 8,987 | 5,539 | 6,936 |

With no client on the tape (smoke, tape on vs off) server CPU went from 58% to about 60.5%.

- **The window resends itself.** A ric has about 65 events/s at tick ×1, but its `bookEvents` viewport receives
  about 900 rows/s. Each new event enters at the top of the seq-desc window and shifts every row, so each viewport
  tick resends the whole window. Rows to the client scale with the window size, not the event rate.
- **At heavy load the tape crowds out the rest.** The server is saturated, and with the tape on it delivers a
  third fewer prices, trades and ladder rows, with higher lag and 300 MB more RSS.
- **A smaller window doesn't fix the server.** At 25 rows the tape's client rows drop by three quarters, but CPU
  and lag barely move. The cost is in the 120 viewports each filtering and sorting the shared tape (50,000 rows,
  `bookEventsCapacity`) on every change, not in the wire.

So the tape stays off by default. Before turning it on:
- Open the event viewports only where they are used. Done: the queue activity they feed is shown only for the user's
  own orders, so `useOrderBook` reads the tape only while a child order is working (and for 30 s after), not for every
  open order book. The `--book-l3=events` runs above are the worst case: every ladder with a tape window.
- Make each event viewport cheaper on the server: a smaller `bookEventsCapacity`, a per-ric table, or a tape the
  client reads from its last seq instead of a sorted window. Reading forward is done; see below.
- Repeat the heavy runs: they were single runs.

### Reading the tape forward

`useBookQueue` now reads the tape forward: `ric = X and seq > N`, seq ascending, up to 500 rows, with N starting at
the marker's seq and moving to the highest seq received once half the window has arrived, or every second. Rows
only ever join the end of the window, so none is sent twice. N has to move well within the ring's lifetime
(`bookEventsCapacity` / tape rate, about 4 s at tick ×1, 1.4 s at ×4): the ring evicts each ric's oldest rows, and an
eviction inside the window shifts it like a new row at the top of a newest-first one.

Measured with `--book-l3=forward` on 2026-11-24, the heavy shape (50 × 8, 120 order books) at tick ×1, 25 s, each
mode run twice alternately (load average 2–3):

| tick ×1, 120 order books | snapshot | events (100, newest first) | forward (500, asc) | forward, 20k ring, 0.5 s |
| --- | --- | --- | --- | --- |
| server CPU (stats file) | 80.6% | 94.9% | 95.4% | 92.6% |
| prices rows/s delivered | 73,450 | 65,570 | 74,200 | 74,215 |
| prices e2e p95 | 76 ms | 137 ms | 72 ms | 72 ms |
| `bookEvents` rows/s per viewport | – | 430 | 45 | 45 |
| server RSS max | 1,024 MB | 1,343 MB | 1,318 MB | 1,194 MB |
| filter moves / s (all viewports) | – | – | 75 | 147 |

- **Forward reading removes the wire cost.** Each viewport receives about the ric's own event rate (45 rows/s, down
  from 430), and prices throughput and latency are back to the snapshot-only baseline. Nothing was skipped and no
  row arrived out of order.
- **It doesn't reduce the server's CPU.** It stays about 15 points over snapshot-only, the same as the newest-first
  window, and moving N less often (31 moves/s, `--advance-ms=2500`) changes nothing (96%). The cost is in keeping
  120 filtered views over the shared tape current on every insert, which only a per-ric table or an indexed `ric`
  filter in the viewport engine would cut.
- **A smaller ring saves memory, not CPU** (about 120 MB at 20k rows), and with a 1.4 s lifetime some rows were
  evicted inside the window. Not worth it.
- **Unsorted is worse.** With `--event-sort=none` (heavy, tick ×4) rows arrived out of order and seqs were skipped,
  so the sort stays.
- At tick ×4 the server is saturated and the machine was busy (load average 4–5), so those runs were too noisy to
  rank precisely: forward delivered 55–62k prices/s, against 48k for the newest-first window and 84k for
  snapshot-only.

On a re-opened tape viewport (each move of N re-subscribes), `BookFeed` holds the book for up to `behindGrace` (4)
snapshots before reloading, so the events can arrive. `useBookQueue` counts activity from when the tape first drives
the book.

With the order book reading the tape only while a child order is working, what remains is about 0.12 points of server
CPU per order book with a working order (tick ×1), and nothing extra on the wire.

## Charts

The chart components ([components/charts.md](components/charts.md)) were profiled with a new `perf:ui` scenario on
2026-10-18 (same shared machine). The `chart-workspace` showcase page shows a price chart (1s bars, VWAP, fills
overlay), a depth chart, a spread/imbalance chart and `MarketDepth` for one instrument. The `trader-workspace`
was re-run for comparison. Remote data, tick ×4:

| scenario, CPU throttle | FPS | long tasks / 15 s | scripting ms/s | style recalc ms/s | main-thread busy ms/s |
| --- | --- | --- | --- | --- | --- |
| chart-workspace, ×1 | 59.9 | 0 | 167 | 49 | 330 |
| trader-workspace, ×1 | 59.9 | 0 | 107 | 17 | 296 |
| chart-workspace, ×4 | 15.9 | 144 | 632 | 78 | 984 |
| trader-workspace, ×4 | 16.1 | 89 | 459 | 41 | 993 |

- **Unthrottled, the charts are smooth at tick ×4**: 60 FPS, no long tasks and no dropped frames. They add about
  60 ms/s of scripting over the trader workspace.
- **At ×4 CPU throttle** both pages are saturated (main thread ~990 ms/s busy), so FPS is the same. The chart page
  has more long tasks (all under 100 ms) because each echarts redraw is a single task. On a loaded machine the
  trader-workspace ×4/×4 number also fell from the earlier 21–23 FPS to 16.
- **The CPU profile** (`--cpu-profile`) has no single hot spot. The time is spread across echarts' own model and
  style code (`Model.getShallow`, `getItemStyle`, `clone`, `DataDiffer`), at 10–30 ms/s each. vuu-chart already
  batches updates to one merge `setOption` per animation frame.
- **Series animation is off** in every trading-ui chart (`disableSeriesAnimation`). Echarts series default to
  `animation: true`, which overrides vuu-chart's global `animation: false`. With it on, every tick restarted a
  900 ms transition, so the treemap never settled and the cartesian charts tweened constantly (trader upstream
  issue 95).
- **Row budget:** each chart subscribes at most `maxRows` rows per DataSource (vuu-chart default 1000;
  `PriceChart` uses 500 bars). The trading-ui charts filter server-side by ric, interval or account, so each
  redraw stays small.
- **Bundle:** echarts adds about 1.1 MB (~370 kB gzip) to the showcase and portal bundles. It isn't code-split yet
  (see Follow-ups).

To profile: `bun run perf:ui --scenario=chart-workspace --tick=4 [--throttle=4] [--cpu-profile]`.

## Hot-spot fixes

The CPU profiles (`perf:ui --cpu-profile`, inclusive time per function) showed that components with no per-tick data still re-rendered on every price or depth tick:
- Salt `Dropdown` (from the link-group selectors);
- `Tooltip`;
- the ladder toolbar.

The causes were:
- `useFollowedInstrument` returns a new `instrument` object on every price tick;
- headers created inline as JSX;
- callbacks without `useCallback`.

| Fix | File |
| --- | --- |
| Ladder `tickSchedule` / `priceFormat` memos keyed on `tickSize` / `tickBands` / `priceDecimals` instead of the per-tick `instrument` object; header `toolbarStart` memoised | `packages/trading-ui/src/components/PriceLadder/PriceLadder.tsx` |
| Toolbar split into a memoised `LadderToolbar`; `recentre` and `handleQuantity` stable | `packages/trading-ui/src/components/PriceLadder/PriceLadderView.tsx` |
| `LinkGroupSelector` wrapped in `memo` (it sits in the header of every ticking component) | `packages/trading-ui/src/components/LinkGroupSelector/LinkGroupSelector.tsx` |

Before and after: remote data, tick ×4, CPU throttle ×4, two runs each.

| Scenario | Metric | Before | After |
| --- | --- | --- | --- |
| trader-workspace | FPS | 19.3 / 19.9 | 22.7 / 21.4 |
| | scripting ms/s | 290 / 284 | 257 / 245 (−13%) |
| | long tasks / 15 s | 78 / 73 | 53 / 40 (−38%) |
| | `Dropdown` inclusive ms/s | 9.6 / 9.3 | 2.6 / 3.0 |
| | `Tooltip` inclusive ms/s | 1.9 | 0 |
| | `PriceLadderView` inclusive ms/s | 3.1 | 2.4 |
| price-ladder-live | FPS | 20.3 / 20.8 | 21.5 / 21.6 |
| | long tasks / 15 s | 124 / 122 | 113 / 101 |
| | `PriceLadderView` inclusive ms/s | 4.8 / 4.1 | 3.4 / 3.7 |
| | `Tooltip` inclusive ms/s | 2.5 | 0 |
| ladder stress (×4) | render avg ms at 50 / 100 / 200 per s | 1.25 / 0.96 / 0.87 | 0.84 / 0.76 / 0.59 (−30%) |
| | render p95 ms | 2.1 / 1.8 / 1.7 | 1.7 / 1.6 / 1.4 |

`renderStability.test.tsx` fails without these fixes.

## Follow-ups

These were found while profiling and are too large or too risky for this pass:

- **`useFollowedInstrument` identity.** It returns a new `instrument` per tick. Splitting the static reference data (tick size, decimals, currency) from the live prices would stop the remaining consumers (`OrderTicket`, `MarketDepth` headers) from re-rendering. `OrderTicket` dropdowns still cost about 2.7 ms/s at ×4 throttle.
- **`TradeTape`** costs about 6 ms/s at ×4 throttle. Its rows re-render on every insert; virtualise or memoise the rows.
- **vuu-table header menus** re-render on data updates: `MenuBase` / `ColumnMenu` cost 8–15 ms/s at ×4 throttle, per table (trader upstream issue 90).
- **`useDataSourceRows`** maps every row through `toTradingRow` on every update. Mapping only the changed rows would cut scripting time in the blotters.
- **Cell renderers.** Sparkline and flash cells in `InstrumentGrid` account for a large share of style recalculation. Try CSS-only flashes and batched sparkline updates.
- **Server.** Event-loop lag p99 reaches 38 ms in the heavy preset. Profile the OMS join (`positionPrices`) and order-book publish paths. Investigate whether sorted viewports re-send whole ranges on insert.
- **Send cycle.** vuu-server's 60 ms / 300-row send cycle sets the e2e latency floor and is not configurable (trader upstream issue 92).
- **Charts.** Lazy-load echarts (`React.lazy` around the chart features) to take it out of the initial bundle. Under CPU throttle, echarts redraws are single long tasks; consider throttling chart redraws to 2–4/s for 1m/5m bars.
- **Intermittent blank workspace** on remote load (trader upstream issue 87). `perf:ui` retries the page load.
