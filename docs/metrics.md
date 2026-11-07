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

All three tables are written once per `metrics.intervalMs` (1 s by default). A row is written only when one of its
values changed, so `lastUpdate` is the time the row last changed.

| Table | Key | One row per | Columns |
| --- | --- | --- | --- |
| `metricsProcess` | process name (`trading`) | server process | `pid`, `started`, `uptimeS`, `cpuPct`, `rssMb`, `heapUsedMb`, `heapTotalMb`, `externalMb`, `loopLagP50Ms`, `loopLagP99Ms`, `loopLagMaxMs` |
| `metrics` | `component.name` | named metric | `component`, `name`, `kind`, `unit`, `value`, `rate`, `mean`, `p50`, `p99`, `max` |
| `metricsTables` | `MODULE.table` | Vuu table | `module`, `table`, `rows`, `counted`, `writes`, `writesPerSec` |

The `metrics` table holds every kind of metric in one place, so adding a metric needs no schema change:

| `kind` | `value` | `rate` | `mean` / `p50` / `p99` / `max` |
| --- | --- | --- | --- |
| `counter` | running total since start | per second over the interval | 0 |
| `gauge` | current value | 0 | 0 |
| `timer` | samples in the interval | samples per second | latency over the interval, in `unit` (µs) |

Notes on the columns:

- `cpuPct` is user + system CPU over the interval, as a percentage of one core. It can exceed 100.
- Event-loop lag is the drift of a 20 ms timer. Bun 1.3 has no `eventLoopUtilization`.
- `metricsTables.rows` covers every table on the server, including joins. `writes` is counted only for the
  tables that trader's own publishers write (`counted = true`). For other tables it is 0.

The definitions are in `@heswell/trading-schemas` (`metricsProcess`, `metrics`, `metricsTables`; see
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
| `vuu` | `viewports` | gauge | Open viewports on the server |

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

- **Access.** Rows are visible to users with the `sim-admin` role. This is the same check as the simulator admin
  tables, and it follows `exchangeSim.permissionMode`: in `auto` mode, users with no roles at all also see them
  (dev auth). On the `start:all` stack, `admin` has `sim-admin`.
- **Perf harness.** With `TRADER_PERF_STATS_FILE` set, `perf:ws` gets its server stats JSONL from the same
  collector, even when `metrics.enabled=0` ([performance.md](performance.md#metrics)).
  `TRADER_PERF_STATS_INTERVAL_MS` overrides the interval for that run.

## 4. How it keeps the cost down

1. **Hot paths only increment counters.** The simulator, publisher and OMS already keep plain number fields
   (`book.events`, `publisher.stats`, `TableSink.writes`). Phase 1 reads those and adds nothing to the matching or
   order paths.
2. **One timer does the rest.** `MetricsCollector` asks each source to report once per interval. It works out
   rates from the previous totals, then hands the snapshot to its listeners (the METRICS tables, the perf stats
   file). Table writes, string keys and allocations all happen here, about once a second.
3. **Small tables.** There are tens of rows, and rows that didn't change aren't rewritten, so a viewport on them
   costs almost nothing.
4. **Timers for later phases are allocation-free.** `Histogram` is a fixed `Uint32Array` of log-scale buckets
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
    w.timer("gateway", "submit", gateway.submitLatency); // a Histogram (µs), reset after each read
  },
});

metrics.register(gatewayMetricsSource(sim.gateway)); // in Main.ts
```

On the hot path, keep to `stats.submits++` and `histogram.record(us)`. Keep the stats object's shape fixed (declare
every field up front), and don't build keys or objects per event.

## 6. Overhead

`perf:ws --preset=heavy` (50 clients × 8 viewports, tick ×4, 200 instruments, local target), run alternately with
`TRADER_METRICS_ENABLED=0` and `1`:

Measured on 2026-11-06 on macOS, 8 CPUs, Bun 1.3.14, on a shared machine (load average about 3–3.5). There are
no METRICS viewports in these runs; the perf stats file is on in both, so the collector runs in both.

| run | metrics | client rows/s | server CPU (stats / ps mean) | RSS max | e2e p95 prices / trades / orders ms | loop lag p99 ms |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | off | 141,287 | 97.8% / 98.8% | 1,133 MB | 70 / 105 / 97 | 33.8 |
| 2 | on | 140,490 | 97.2% / 99.2% | 1,119 MB | 79 / 105 / 105 | 124.4 |
| 3 | off | 138,745 | 99.6% / 98.0% | 1,204 MB | 75 / 105 / 117 | 102.6 |
| 4 | on | 142,525 | 97.1% / 96.2% | 1,398 MB | 70 / 105 / 84 | 37.9 |

The two settings can't be told apart: the differences between them are smaller than the spread between runs of
the same setting. Event-loop lag p99 at this load is a single GC pause or two, which is why it jumps between
34 and 124 ms whichever way metrics is set. That fits the design: phase 1 adds a table write about once a second
and nothing on the hot paths. Phase 2's timers do touch hot paths, so they should be measured the same way, with
`all` and `sampled` compared against `off`.

## 7. Roadmap

1. **Phase 1 (this page).** Collector, histogram, process sampler, the three tables, and the existing counters.
   `PerfStatsReporter` is ported to the collector.
2. **Phase 2: timers.** Sampled timers on the hot paths, with sampling on or off as a startup setting:
   - book `limit` / `market` matching;
   - simulator `step` and `flush`;
   - gateway submit, amend and cancel;
   - OMS RPCs (receive → reply);
   - pre-trade risk checks;
   - execution report handling;
   - order lifecycle latencies (create → sent → ack → first fill).

   Counters for rejects by reason, duplicate execution reports dropped, and `OrderStateError`s ignored.
3. **Phase 3: history and UI.** A `metricsHistory` ring buffer (like `simSamples`), and an admin-only Metrics
   feature with sparklines.
4. **Phase 4: upstream.** vuu-server session, send-cycle and queue stats (trader upstream issue 91). Today only
   `viewportCount` and table row counts can be read.
