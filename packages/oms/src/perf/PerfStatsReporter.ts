import { appendFileSync, writeFileSync } from "node:fs";
import type {
  MetricsCollector,
  MetricsSnapshot,
} from "@heswell/trading-metrics";
import { OMS_MODULE } from "@heswell/trading-schemas";

/** One line of the perf stats JSONL file (cumulative counters). */
export interface PerfStatsSample {
  /** Wall clock (ms since epoch). */
  ts: number;
  pid: number;
  /** process.cpuUsage() totals, microseconds. */
  cpuUserUs: number;
  cpuSystemUs: number;
  rssBytes: number;
  heapUsedBytes: number;
  /** Event-loop lag over the interval (timer drift, ms). */
  loopLagMaxMs: number;
  loopLagP99Ms: number;
  bookEvents: number;
  trades: number;
  deferredSteps: number;
  flushes: number;
  priceUpdates: number;
  depthUpdates: number;
  tradeInserts: number;
  tradeEvictions: number;
  /** OMS table writes per table. */
  omsWrites: Record<string, number>;
}

/** The perf harness line for a metrics snapshot. */
export const toPerfStatsSample = (
  snapshot: MetricsSnapshot,
): PerfStatsSample => {
  const values = new Map(snapshot.metrics.map((m) => [m.id, m.value]));
  const value = (id: string) => values.get(id) ?? 0;
  const p = snapshot.process;
  return {
    ts: snapshot.time,
    pid: p?.pid ?? process.pid,
    cpuUserUs: p?.cpuUserUs ?? 0,
    cpuSystemUs: p?.cpuSystemUs ?? 0,
    rssBytes: p?.rssBytes ?? 0,
    heapUsedBytes: p?.heapUsedBytes ?? 0,
    loopLagMaxMs: p?.loopLagMaxMs ?? 0,
    loopLagP99Ms: p?.loopLagP99Ms ?? 0,
    bookEvents: value("exchange.bookEvents"),
    trades: value("exchange.trades"),
    deferredSteps: value("exchange.deferredSteps"),
    flushes: value("publisher.flushes"),
    priceUpdates: value("publisher.priceUpdates"),
    depthUpdates: value("publisher.depthUpdates"),
    tradeInserts: value("publisher.tradeInserts"),
    tradeEvictions: value("publisher.tradeEvictions"),
    omsWrites: Object.fromEntries(
      snapshot.tables
        .filter((t) => t.module === OMS_MODULE && t.counted)
        .map((t) => [t.table, t.writes]),
    ),
  };
};

/**
 * Appends a line per metrics snapshot to a JSONL file, for the perf harness
 * (packages/perf). Enabled in Main by TRADER_PERF_STATS_FILE; off by
 * default. The collector's interval sets the line rate.
 */
export function startPerfStatsReporter(
  file: string,
  collector: MetricsCollector,
) {
  writeFileSync(file, "");
  return collector.onSnapshot((snapshot) =>
    appendFileSync(file, `${JSON.stringify(toPerfStatsSample(snapshot))}\n`),
  );
}
