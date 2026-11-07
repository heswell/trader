import { defineTable, type RowOf } from "./tableDefinition";

/**
 * Vuu module of the server metrics tables (see docs/metrics.md). The tables
 * are written once per `metrics.intervalMs` by `@heswell/trading-metrics`,
 * never from a hot path.
 */
export const METRICS_MODULE = "METRICS";

export const metricsProcess = defineTable({
  module: METRICS_MODULE,
  name: "metricsProcess",
  keyField: "id",
  description:
    "One row per server process: CPU, memory and event-loop lag over the last interval (like the Scala server's metricsJvm).",
  columns: [
    { name: "id", dataType: "string", description: "Process name." },
    { name: "pid", dataType: "int" },
    { name: "started", dataType: "epochtimestamp" },
    { name: "uptimeS", dataType: "double", description: "Seconds." },
    {
      name: "cpuPct",
      dataType: "double",
      description:
        "User + system CPU over the interval, % of one core (can exceed 100).",
    },
    { name: "rssMb", dataType: "double" },
    { name: "heapUsedMb", dataType: "double" },
    { name: "heapTotalMb", dataType: "double" },
    { name: "externalMb", dataType: "double" },
    {
      name: "loopLagP50Ms",
      dataType: "double",
      description:
        "Event-loop lag (timer drift of a 20 ms probe) over the interval.",
    },
    { name: "loopLagP99Ms", dataType: "double" },
    { name: "loopLagMaxMs", dataType: "double" },
    { name: "lastUpdate", dataType: "epochtimestamp" },
  ],
});

export const metrics = defineTable({
  module: METRICS_MODULE,
  name: "metrics",
  keyField: "id",
  description:
    "Every named metric, one row each; key 'component.name'. Counters carry a running total and a per-second rate, gauges a current value, timers a count and latency percentiles over the interval.",
  columns: [
    { name: "id", dataType: "string" },
    {
      name: "component",
      dataType: "string",
      description: "e.g. exchange, publisher, oms, vuu.",
    },
    { name: "name", dataType: "string" },
    {
      name: "kind",
      dataType: "string",
      description: "counter, gauge or timer.",
    },
    {
      name: "unit",
      dataType: "string",
      description:
        "Unit of value (counter, gauge) or of the percentiles (timer).",
    },
    {
      name: "value",
      dataType: "double",
      description:
        "Counter: running total. Gauge: current value. Timer: calls timed in the interval.",
    },
    {
      name: "rate",
      dataType: "double",
      description:
        "Per second over the interval: counter increments, or timer calls (timed or not); 0 for a gauge.",
    },
    { name: "mean", dataType: "double", optional: true },
    { name: "p50", dataType: "double", optional: true },
    { name: "p99", dataType: "double", optional: true },
    { name: "max", dataType: "double", optional: true },
    {
      name: "lastUpdate",
      dataType: "epochtimestamp",
      description: "When the row last changed.",
    },
  ],
});

export const metricsTables = defineTable({
  module: METRICS_MODULE,
  name: "metricsTables",
  keyField: "id",
  description:
    "One row per Vuu table on the server; key 'MODULE.table'. Row counts for every table; writes for the tables trader's publishers count.",
  columns: [
    { name: "id", dataType: "string" },
    { name: "module", dataType: "string" },
    { name: "table", dataType: "string" },
    { name: "rows", dataType: "long" },
    {
      name: "counted",
      dataType: "boolean",
      description: "True when writes are counted for this table.",
    },
    {
      name: "writes",
      dataType: "long",
      description:
        "Inserts + updates + deletes since start (0 if not counted).",
    },
    { name: "writesPerSec", dataType: "double" },
    { name: "lastUpdate", dataType: "epochtimestamp" },
  ],
});

export const metricsHistory = defineTable({
  module: METRICS_MODULE,
  name: "metricsHistory",
  keyField: "id",
  description:
    "Rolling history of every metric, one row per metric per snapshot (metrics.historySize kept per metric); key 'metric|time' (see metricsHistoryKey). Also holds the process values (component 'process') and table writes (component 'table').",
  columns: [
    { name: "id", dataType: "string" },
    {
      name: "metric",
      dataType: "string",
      description:
        "A metrics id (component.name), process.<column> or table.<MODULE.table>.",
    },
    { name: "component", dataType: "string" },
    { name: "name", dataType: "string" },
    { name: "kind", dataType: "string" },
    { name: "unit", dataType: "string" },
    { name: "time", dataType: "epochtimestamp", description: "Snapshot time." },
    {
      name: "value",
      dataType: "double",
      description: "As metrics.value; process values; a table's writes total.",
    },
    {
      name: "rate",
      dataType: "double",
      description: "As metrics.rate; a table's writes per second.",
    },
    { name: "p50", dataType: "double", optional: true },
    { name: "p99", dataType: "double", optional: true },
    { name: "max", dataType: "double", optional: true },
  ],
});

/** Key of a metricsHistory row. */
export const metricsHistoryKey = (metric: string, time: number) =>
  `${metric}|${time}`;

export const metricsModuleTables = {
  metricsProcess,
  metrics,
  metricsTables,
  metricsHistory,
} as const;

export type MetricsProcessRow = RowOf<typeof metricsProcess>;
export type MetricRow = RowOf<typeof metrics>;
export type MetricsTableRow = RowOf<typeof metricsTables>;
export type MetricsHistoryRow = RowOf<typeof metricsHistory>;
