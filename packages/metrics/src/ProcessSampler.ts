import { Histogram } from "./Histogram";

/** Process metrics over the last interval. */
export interface ProcessMetrics {
  pid: number;
  /** Process start (wall clock, ms). */
  started: number;
  uptimeS: number;
  /** User + system CPU over the interval, % of one core. */
  cpuPct: number;
  /** process.cpuUsage() totals, µs. */
  cpuUserUs: number;
  cpuSystemUs: number;
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
  loopLagP50Ms: number;
  loopLagP99Ms: number;
  loopLagMaxMs: number;
}

export interface ProcessSamplerOptions {
  /** Interval of the event-loop lag probe (ms). Default 20. */
  lagTickMs?: number;
}

/**
 * CPU, memory and event-loop lag of this process. Lag is the drift of a
 * `lagTickMs` timer (Bun 1.3 has no eventLoopUtilization), recorded into a
 * histogram, so the probe itself does not allocate.
 */
export class ProcessSampler {
  readonly lagTickMs: number;
  readonly #lag = new Histogram();
  #lagTimer: ReturnType<typeof setInterval> | undefined;
  #expected = 0;
  #lastCpu = process.cpuUsage();
  #lastHr = process.hrtime.bigint();

  constructor({ lagTickMs = 20 }: ProcessSamplerOptions = {}) {
    this.lagTickMs = lagTickMs;
  }

  start() {
    if (this.#lagTimer) return;
    this.#expected = performance.now() + this.lagTickMs;
    this.#lagTimer = setInterval(() => {
      const now = performance.now();
      // µs, so the histogram's resolution suits sub-millisecond lag
      this.#lag.record(Math.max(0, now - this.#expected) * 1_000);
      this.#expected = now + this.lagTickMs;
    }, this.lagTickMs);
    this.#lagTimer.unref?.();
  }

  stop() {
    clearInterval(this.#lagTimer);
    this.#lagTimer = undefined;
  }

  /** Metrics since the previous sample; resets the lag histogram. */
  sample(): ProcessMetrics {
    const cpu = process.cpuUsage();
    const hr = process.hrtime.bigint();
    const wallUs = Number(hr - this.#lastHr) / 1_000;
    const cpuUs =
      cpu.user - this.#lastCpu.user + (cpu.system - this.#lastCpu.system);
    this.#lastCpu = cpu;
    this.#lastHr = hr;
    const mem = process.memoryUsage();
    const lag = this.#lag;
    const uptimeS = process.uptime();
    const metrics: ProcessMetrics = {
      pid: process.pid,
      started: Math.round(Date.now() - uptimeS * 1_000),
      uptimeS,
      cpuPct: wallUs > 0 ? (100 * cpuUs) / wallUs : 0,
      cpuUserUs: cpu.user,
      cpuSystemUs: cpu.system,
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      heapTotalBytes: mem.heapTotal,
      externalBytes: mem.external,
      loopLagP50Ms: lag.percentile(0.5) / 1_000,
      loopLagP99Ms: lag.percentile(0.99) / 1_000,
      loopLagMaxMs: lag.max / 1_000,
    };
    lag.reset();
    return metrics;
  }
}
