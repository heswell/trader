# @heswell/trading-metrics

Server metrics for the trading server, published as Vuu tables in a `METRICS` module. See
[docs/metrics.md](../../docs/metrics.md) for the tables, the metrics, configuration and overhead.

| Export | Entry | What |
| --- | --- | --- |
| `Histogram` | `.` | Fixed-size log-linear latency histogram; `record()` does not allocate |
| `MetricsCollector`, `MetricSource`, `MetricsWriter` | `.` | Takes a snapshot of the registered sources once per interval and works out rates |
| `ProcessSampler` | `.` | CPU, memory and event-loop lag of the process |
| `MetricsModule` | `./server` | The Vuu module: `metricsProcess`, `metrics`, `metricsTables` |
| `vuuServerSource` | `./server` | Viewport count and per-table row counts from vuu-server |

```ts
const metrics = new MetricsCollector({ intervalMs: 1_000 });
metrics.register(mySource);
const application = createVuuServerApplication({
  // ...
  modules: [/* ... */ MetricsModule(metrics, { canView })],
});
metrics.register(vuuServerSource(() => application.server));
```

The trading sources (exchange simulator, publisher, OMS) are in `packages/oms/src/metrics`.
