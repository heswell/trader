# Server metrics

The trading server publishes its own performance metrics as Vuu tables in a `METRICS` module. This is the same
idea as the Scala Vuu server's metrics module. The metrics show what the exchange simulator, the market data
publisher, the OMS, vuu-server and the process are doing. Any Vuu client with the `sim-admin` role can read them,
with the same viewports, sorting and filtering as any other table.

- [1. Tables](#1-tables)
- [2. Metrics](#2-metrics)
- [3. Configuration and access](#3-configuration-and-access)
- [4. How it keeps the cost down](#4-how-it-keeps-the-cost-down)
- [5. Adding a metric](#5-adding-a-metric)
- [6. Overhead](#6-overhead)
- [7. Roadmap](#7-roadmap)

## 1. Tables

All five tables are written once per `metrics.intervalMs` (1 s by default). A `metricsProcess`, `metrics`,
`metricsTables` or `metricsSessions` row is written only when one of its values changed, so `lastUpdate` is the time
the row last changed. `metricsHistory` gets a row for every metric at every snapshot.

| Table | Key | One row per | Columns |
| --- | --- | --- | --- |
| `metricsProcess` | process name (`trading`) | server process | `pid`, `started`, `uptimeS`, `cpuPct`, `rssMb`, `heapUsedMb`, `heapTotalMb`, `externalMb`, `loopLagP50Ms`, `loopLagP99Ms`, `loopLagMaxMs` |
| `metrics` | `component.name` | named metric | `component`, `name`, `kind`, `unit`, `value`, `rate`, `mean`, `p50`, `p99`, `max` |
| `metricsTables` | `MODULE.table` | Vuu table | `module`, `table`, `rows`, `counted`, `writes`, `writesPerSec` |
| `metricsSessions` | Vuu session id | client session, removed when it closes | `user`, `connected`, `queueLength`, `rowsQueuedPerSec`, `rowsSentPerSec`, `coalescedPct`, `messagesPerSec`, `kbPerSec`, `rowsSent`, `rowsDropped` |
| `metricsHistory` | `metric\|time` | metric per snapshot, the last `metrics.historySize` kept | `metric`, `component`, `name`, `kind`, `unit`, `time`, `value`, `rate`, `p50`, `p99`, `max` |

The `metrics` table holds every kind of metric in one place, so adding a metric needs no schema change:

| `kind` | `value` | `rate` | `mean` / `p50` / `p99` / `max` |
| --- | --- | --- | --- |
| `counter` | running total since start | per second over the interval | 0 |
| `gauge` | current value | 0 | 0 |
| `timer` | calls timed in the interval | calls per second (timed or not) | latency of the timed calls over the interval, in `unit` (µs) |

Notes on the columns:

- `cpuPct` is user + system CPU over the interval, as a percentage of one core. It can exceed 100.
- Event-loop lag is the drift of a 20 ms timer. Bun 1.3 has no `eventLoopUtilization`.
- A timer's `rate` counts every call, so it is right in every mode. `value` and the latency columns only
  count timed calls: one in `metrics.sampleEvery` when `sampled`, none when `off`.
- `metricsSessions` rates are per second over the interval, from the session's counters (0 in its first
  snapshot). `coalescedPct` is the share of the interval's queued updates merged into one already waiting.
  `rowsSent` and `rowsDropped` count since login. The table is empty on the in-browser data.
- `metricsTables.rows` covers every table on the server, including joins. `writes` is counted only for the
  tables that trader's own publishers write (`counted = true`). For other tables it is 0.

`metricsHistory` holds every `metrics` row (`metric` = its id), the process values `process.cpuPct`, `rssMb`,
`heapUsedMb`, `loopLagP99Ms` and `loopLagMaxMs` (gauges), and each counted table's writes as `table.<MODULE.table>`
(a counter: `value` = writes, `rate` = writes per second). With about 80 metrics and the default 300 snapshots it
holds about 24,000 rows, and each snapshot inserts and deletes about 80.

The definitions are in `@heswell/trading-schemas` (`metricsProcess`, `metrics`, `metricsTables`, `metricsHistory`, `metricsSessions`; see
[schemas.md](schemas.md) and the [API reference](api/trading-schemas.md)).

## 2. Metrics

| Component | Metric | Kind | What |
| --- | --- | --- | --- |
| `exchange` | `bookEvents` | counter | Order book changes (adds, amends, cancels, trades) |
| | `trades` | counter | Trades |
| | `volume` | counter | Shares traded |
| | `deferredSteps` | counter | Simulator steps cut short by `maxOpsPerStep`. If this rate is above 0, the simulator is saturated. |
| | `books` / `continuousBooks` | gauge | Active books, and books in continuous trading |
| `publisher` | `flushes` | counter | Publish cycles (`publishIntervalMs`) |
| | `priceUpdates`, `depthUpdates`, `tradeInserts`, `tradeEvictions` | counter | Rows written to `prices`, `depth`, `trades` |
| | `coalescedPct` | gauge | Share of book events merged by the publish throttle over the interval: 1 − price updates ÷ book events |
| `oms` | `parentOrders`, `liveOrders`, `positions`, `runningAlgos` | gauge | Orders held, orders not yet terminal, positions, algos running |
| | `rejects`, `rejects.<reason>` | counter | Rejected `createOrder` / `amendOrder` / `cancelOrder` requests (including risk), in all and by reason |
| | `exchangeRejects`, `exchangeRejects.<reason>` | counter | Child orders the exchange rejected, in all and by reason |
| | `duplicateReports` | counter | Execution reports dropped because the child had already applied them |
| | `unknownReports` | counter | Execution reports for no known child order |
| | `stateErrorsIgnored` | counter | Order events the state machine refused (`OrderStateError`), logged and ignored |
| `vuu` | `viewports` | gauge | Open viewports on the server |
| | `sessions` | gauge | Client sessions logged in ¹ |
| | `queuedRows` / `queuedRowsMax` | gauge | Row updates waiting to be sent, over all sessions and in the most backed-up one ¹ |
| | `rowsQueued`, `rowsCoalesced`, `rowsSent`, `rowsDropped` | counter | Row updates queued for clients, merged into one already waiting, sent, and dropped because the row had left the viewport's range by send time ¹ |
| | `messagesSent`, `kbSent` | counter | `TABLE_ROW` messages and KB of JSON sent to clients ¹ |
| | `coalescedPct` | gauge | Share of queued row updates merged before they were sent, over the interval ¹ |
| | `sendCycle` | timer | Duration of vuu-server's send cycle (every 60 ms, all sessions), timed on every cycle ¹ |

¹ From vuu-server 4.5.0 (trader upstream issue 91); with an older server `vuuServerSource` reports only the
viewports and table rows. The counters are totals over all sessions, built from each session's change between
reads, so they do not fall when a session closes. Rows a session sent after the last read before it closed are
not counted.

### Timers

Every timer is in µs. Timers nest: `gateway.submit` includes the `exchange.limit` it causes, and
`oms.createOrder` includes both when the gateway has no latency.

| Timer | What it covers |
| --- | --- |
| `exchange.limit`, `market`, `modify`, `cancel` | One book operation: matching plus the fill callbacks to the order's owner. Bots and the gateway both go through these. |
| `exchange.step` | One simulator step: session, price models and bots for every book |
| `publisher.flush` | One publish cycle: dirty books and pending trades to the EXCHANGE tables |
| `gateway.submit`, `amend`, `cancel` | One gateway request: validation, matching and building the reports. Delivering the reports to the OMS is not included. |
| `oms.createOrder`, `amendOrder`, `cancelOrder` | One OMS request, whether it comes from an RPC or the background flow |
| `oms.risk` | One pre-trade risk check (create and amend) |
| `oms.executionReport` | Applying one execution report: order state, fills, positions, algo container |
| `oms.childAck` | Order lifecycle: child order sent → exchange ack, from the order's timestamps (ms resolution) |
| `oms.firstFill` | Order lifecycle: DMA parent created → first fill (ms resolution). Algo parents are left out, because their first fill waits on the schedule. |

The lifecycle timers are only as precise as the OMS clock (`Date.now`, 1 ms). Replayed reports after a restart are
not counted.

The table writes in `metricsTables` come from the same sources:

- **EXCHANGE:** the market data publisher counts writes to `prices`, `depth`, `trades`, `bars`, `bookSamples`,
  `bookOrders` and `bookEvents`.
- **OMS:** `TableSink` counts writes to every OMS table.

The sources are in [`packages/oms/src/metrics/tradingSources.ts`](../packages/oms/src/metrics/tradingSources.ts),
next to `Main.ts`, which is where the simulator and the OMS are put together.

## 3. Configuration and access

| Conf key | Env var | Default | Meaning |
| --- | --- | --- | --- |
| `metrics.enabled` | `METRICS_ENABLED` / `TRADER_METRICS_ENABLED` | `1` | `0`: no METRICS module and no collector timer |
| `metrics.intervalMs` | `METRICS_INTERVAL_MS` / `TRADER_METRICS_INTERVAL_MS` | `1000` | Snapshot interval |
| `metrics.timers` | `METRICS_TIMERS` / `TRADER_METRICS_TIMERS` | `sampled` | `off`: calls are counted, nothing is timed. `sampled`: one call in `sampleEvery` is timed. `all`: every call is timed. |
| `metrics.sampleEvery` | `METRICS_SAMPLE_EVERY` / `TRADER_METRICS_SAMPLE_EVERY` | `16` | Sampling rate for `sampled` (a power of two) |
| `metrics.historySize` | `METRICS_HISTORY_SIZE` / `TRADER_METRICS_HISTORY_SIZE` | `300` | `metricsHistory` snapshots kept per metric (5 minutes at 1 s); `0` = no history |

- **Access.** Rows are visible to users with the `sim-admin` role. This is the same check as the simulator admin
  tables, and it follows `exchangeSim.permissionMode`: in `auto` mode, users with no roles at all also see them
  (dev auth). On the `start:all` stack, `admin` has `sim-admin`.
- **Timers off.** Timers are set to `off` when nothing reads them (`metrics.enabled=0` and no perf stats file).
- **UI.** Simulator › Metrics (`sim-admin-access`) shows the five tables: process cards with sparklines, every
  metric with trends of its rate and p99, table writes, client sessions, and the history chart of whatever is selected
  ([components](components/simulator.md#server-metrics)). The showcase (`#server-metrics`) and the UI tests use
  the same tables from `@heswell/trading-test-data`, without the process row.
- **Perf harness.** With `TRADER_PERF_STATS_FILE` set, `perf:ws` gets its server stats JSONL from the same
  collector, even when `metrics.enabled=0` ([performance.md](performance.md#metrics)).
  `TRADER_PERF_STATS_INTERVAL_MS` overrides the interval for that run.

## 4. How it keeps the cost down

1. **Hot paths only increment counters and sample timers.** The simulator, publisher and OMS keep plain number
   fields (`book.events`, `publisher.stats`, `TableSink.writes`, `engine.stats`). A `Timer` counts every call and
   reads the clock (`performance.now()`) only for the calls it samples: `(++calls & mask) === 0`.
2. **One timer does the rest.** `MetricsCollector` asks each source to report once per interval. It works out
   rates from the previous totals, then hands the snapshot to its listeners (the METRICS tables, the perf stats
   file). Table writes, string keys and allocations all happen here, about once a second.
3. **Small tables.** There are tens of rows, and rows that didn't change aren't rewritten, so a viewport on them
   costs almost nothing.
4. **Timers are allocation-free.** `Histogram` is a fixed `Uint32Array` of log-scale buckets
   (16 per power of two, so each is about 6% wide). `record()` does one bucket calculation and a few field writes.
   Percentiles are read by the collector, which then resets the histogram.
5. **A failing source can't break the others.** If a source throws, the error is logged once and the rest of the
   snapshot is still published.

## 5. Adding a metric

A source reads its own counters and reports them:

```ts
import type { MetricSource } from "@heswell/trading-metrics";

export const gatewayMetricsSource = (gateway: SimExchangeGateway): MetricSource => ({
  name: "gateway",
  collect(w) {
    w.counter("gateway", "submits", gateway.stats.submits); // a monotonic total
    w.gauge("gateway", "liveOrders", gateway.liveOrderCount); // a current value
  },
});

metrics.register(gatewayMetricsSource(sim.gateway)); // in Main.ts
```

A timer comes from the component's `TimerRegistry` (`sim.timers`, `engine.timers`), which the sources already
report with `w.timers(registry)` and Main sets to `metrics.timers`:

```ts
// once, e.g. in the constructor
this.#submitTimer = this.timers.timer("gateway", "submit");

// on the hot path
const t0 = this.#submitTimer.start();
doSubmit();
this.#submitTimer.stop(t0);

// or a latency worked out from timestamps (µs)
this.#ackTimer.record((now - child.created) * 1_000);
```

On the hot path, keep to `stats.submits++` and `timer.start()` / `timer.stop()`. Look the timer up once, not per
call. Keep the stats object's shape fixed (declare every field up front), and don't build keys or objects per
event.

## 6. Overhead

Measured on 2026-11-06 and 2026-11-07 on macOS, 8 CPUs, Bun 1.3.14, on a shared machine (load average 3–6).

### Phase 1: the tables

`perf:ws --preset=heavy` (50 clients × 8 viewports, tick ×4, 200 instruments, local target), run alternately with
`TRADER_METRICS_ENABLED=0` and `1`. There are no METRICS viewports in these runs; the perf stats file is on in both,
so the collector runs in both.

| run | metrics | client rows/s | server CPU (stats / ps mean) | RSS max | e2e p95 prices / trades / orders ms | loop lag p99 ms |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | off | 141,287 | 97.8% / 98.8% | 1,133 MB | 70 / 105 / 97 | 33.8 |
| 2 | on | 140,490 | 97.2% / 99.2% | 1,119 MB | 79 / 105 / 105 | 124.4 |
| 3 | off | 138,745 | 99.6% / 98.0% | 1,204 MB | 75 / 105 / 117 | 102.6 |
| 4 | on | 142,525 | 97.1% / 96.2% | 1,398 MB | 70 / 105 / 84 | 37.9 |

The two settings can't be told apart: the differences between them are smaller than the spread between runs of
the same setting. Event-loop lag p99 at this load is a single GC pause or two, which is why it jumps between
34 and 124 ms whichever way metrics is set.

### Phase 2: the timers

**Cost per call** (a start/stop pair in a tight loop, less the empty loop, two rounds):

| mode | ns per call |
| --- | --- |
| `off` | 1–2.5 |
| `sampled` (1 in 16) | 6–8 |
| `all` | 64–70 |

**Simulator capacity** (`bench --mode=max --seconds=20 --timers=…`, 200 books, no clients), book events per wall
second, alternating modes:

| round | off | sampled | all |
| --- | --- | --- | --- |
| 1 | 25,000 (machine busy) | 40,238 | 43,565 |
| 2 | 44,748 | 43,322 | 45,178 |
| 3 | 42,344 | 41,128 | 41,317 |

The modes are within the run-to-run noise of about ±5%.

**Heavy websocket load** (`perf:ws --preset=heavy`, `TRADER_METRICS_TIMERS=…`), two rounds, the second in reverse
order:

| mode | client rows/s | server CPU (stats) | e2e p95 prices / trades / orders ms | book events/s |
| --- | --- | --- | --- | --- |
| off | 132,001 / 131,189 | 116.4% / 116.4% | 101 / 119 / 143, 104 / 129 / 128 | 37,394 / 37,406 |
| sampled | 122,909 / 130,967 | 119.8% / 116.0% | 97 / 105 / 159, 98 / 114 / 120 | 37,114 / 37,421 |
| all | 125,723 / 127,681 | 120.3% / 117.8% | 96 / 102 / 136, 105 / 129 / 141 | 37,134 / 37,256 |

`sampled` matches `off` (its first run is the outlier of the set). `all` is about 2–3% lower in both rounds,
which fits its per-call cost, so `sampled` is the default. `all` is useful for short diagnostic runs.

## 7. Roadmap

1. **Phase 1 (done).** Collector, histogram, process sampler, the three tables, and the existing counters.
   `PerfStatsReporter` is ported to the collector.
2. **Phase 2 (done).** Sampled timers on matching, step, flush, the gateway, OMS requests, risk checks and
   execution reports; order lifecycle latencies; counters for rejects, dropped reports and ignored state errors.
3. **Phase 3 (done).** The `metricsHistory` table and the Simulator › Metrics feature.
4. **Phase 4: upstream (done).** vuu-server 4.5.0 reports per-session outbound counters (`getSessionStats()`),
   the session count and send-cycle timings (`onSendCycle`) (vuu-websocket#114, trader upstream issue 91).
   `vuuServerSource` publishes them as the `vuu` metrics above.
5. **Per-session table (done).** `metricsSessions`: a row per client session with its queue depth and send
   rates, shown in the Metrics feature's Sessions grid.
