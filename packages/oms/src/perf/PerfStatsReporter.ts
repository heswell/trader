import { appendFileSync, writeFileSync } from "node:fs";
import type { ExchangeSimulator } from "@heswell/exchange-sim";
import type { OmsService } from "../engine/OmsService";

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

const LAG_TICK_MS = 20;

/**
 * Appends a cumulative stats sample per interval to a JSONL file, for the
 * perf harness (scripts/perf). Enabled in Main by TRADER_PERF_STATS_FILE;
 * off by default.
 */
export function startPerfStatsReporter(
  file: string,
  sim: ExchangeSimulator,
  oms: OmsService,
  intervalMs = 1_000,
) {
  writeFileSync(file, "");
  let lags: number[] = [];
  let expected = performance.now() + LAG_TICK_MS;
  const lagTimer = setInterval(() => {
    const now = performance.now();
    lags.push(Math.max(0, now - expected));
    expected = now + LAG_TICK_MS;
  }, LAG_TICK_MS);

  const sample = (): PerfStatsSample => {
    const cpu = process.cpuUsage();
    const mem = process.memoryUsage();
    const sorted = lags.sort((a, b) => a - b);
    lags = [];
    const publisher = sim.publisher?.stats;
    return {
      ts: Date.now(),
      pid: process.pid,
      cpuUserUs: cpu.user,
      cpuSystemUs: cpu.system,
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      loopLagMaxMs: sorted.at(-1) ?? 0,
      loopLagP99Ms: sorted[Math.floor(sorted.length * 0.99)] ?? 0,
      bookEvents: sim.bookEvents,
      trades: sim.tradeCount,
      deferredSteps: sim.deferredSteps,
      flushes: publisher?.flushes ?? 0,
      priceUpdates: publisher?.priceUpdates ?? 0,
      depthUpdates: publisher?.depthUpdates ?? 0,
      tradeInserts: publisher?.tradeInserts ?? 0,
      tradeEvictions: publisher?.tradeEvictions ?? 0,
      omsWrites: { ...oms.tables.writes },
    };
  };
  const timer = setInterval(
    () => appendFileSync(file, `${JSON.stringify(sample())}\n`),
    intervalMs,
  );
  return () => {
    clearInterval(timer);
    clearInterval(lagTimer);
  };
}
