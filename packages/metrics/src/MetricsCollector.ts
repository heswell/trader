import { Histogram } from "./Histogram";
import { ProcessSampler, type ProcessMetrics } from "./ProcessSampler";
import type { Timer, TimerRegistry } from "./Timer";

export type MetricKind = "counter" | "gauge" | "timer";

/** One metric in a snapshot (a row of METRICS.metrics). */
export interface MetricValue {
  /** `component.name`. */
  id: string;
  component: string;
  name: string;
  kind: MetricKind;
  unit: string;
  /** Counter: running total. Gauge: current value. Timer: samples timed in the interval. */
  value: number;
  /**
   * Per second over the interval: counter increments, or timer calls (timed
   * or not); 0 for a gauge.
   */
  rate: number;
  /** Timers only. */
  mean?: number;
  p50?: number;
  p99?: number;
  max?: number;
}

/** One Vuu table in a snapshot (a row of METRICS.metricsTables). */
export interface TableMetric {
  /** `MODULE.table`. */
  id: string;
  module: string;
  table: string;
  rows: number;
  /** True when a source reported writes for the table. */
  counted: boolean;
  writes: number;
  writesPerSec: number;
}

export interface MetricsSnapshot {
  time: number;
  /** Time since the previous snapshot (ms); 0 for the first. */
  intervalMs: number;
  process?: ProcessMetrics;
  metrics: MetricValue[];
  tables: TableMetric[];
}

/**
 * What a source reports to, once per interval. Sources read their own
 * counters (plain number fields bumped on the hot path) and pass the values
 * on; the collector works out the rates.
 */
export interface MetricsWriter {
  /** A monotonic total, e.g. trades since start. */
  counter(component: string, name: string, total: number, unit?: string): void;
  /** A current value, e.g. live orders. */
  gauge(component: string, name: string, value: number, unit?: string): void;
  /**
   * Latencies recorded since the last snapshot. The collector reads the
   * histogram and resets it, so a source keeps one Timer (or Histogram) per
   * timer. A Timer's rate is its calls per second; a bare Histogram's is its
   * samples per second.
   */
  timer(
    component: string,
    name: string,
    timer: Timer | Histogram,
    unit?: string,
  ): void;
  /** Every timer in a registry. */
  timers(registry: TimerRegistry): void;
  /** Current row count of a Vuu table. */
  tableRows(module: string, table: string, rows: number): void;
  /** Monotonic count of writes (insert + update + delete) to a Vuu table. */
  tableWrites(module: string, table: string, total: number): void;
}

export interface MetricSource {
  /** Shown when the source throws. */
  readonly name: string;
  collect(writer: MetricsWriter, now: number): void;
}

export interface MetricsCollectorOptions {
  /** Snapshot interval (ms). Default 1000. */
  intervalMs?: number;
  /** Wall clock (ms). Default Date.now. */
  clock?: () => number;
  /** Process CPU / memory / event-loop lag; false to leave it out. */
  process?: ProcessSampler | false;
  /** Where source errors go (each source is reported once). */
  log?: (message: string) => void;
}

type SnapshotListener = (snapshot: MetricsSnapshot) => void;

/**
 * Collects metrics from the registered sources on a timer (or on demand with
 * `sample`) and hands each snapshot to its listeners, e.g. the METRICS
 * tables and the perf stats file. Everything here runs once per interval,
 * off the hot path.
 */
export class MetricsCollector {
  readonly intervalMs: number;
  readonly process: ProcessSampler | undefined;
  readonly #clock: () => number;
  readonly #log: (message: string) => void;
  readonly #sources = new Set<MetricSource>();
  readonly #failed = new Set<MetricSource>();
  readonly #listeners = new Set<SnapshotListener>();
  /** Previous totals (counters and table writes), for rates. */
  #previous = new Map<string, number>();
  #lastTime: number | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #latest: MetricsSnapshot | undefined;

  constructor({
    intervalMs = 1_000,
    clock = Date.now,
    process: processSampler,
    log = () => {},
  }: MetricsCollectorOptions = {}) {
    if (!(intervalMs > 0)) throw Error("metrics intervalMs must be > 0");
    this.intervalMs = intervalMs;
    this.#clock = clock;
    this.#log = log;
    this.process =
      processSampler === false
        ? undefined
        : (processSampler ?? new ProcessSampler());
  }

  register(source: MetricSource) {
    this.#sources.add(source);
    return () => {
      this.#sources.delete(source);
    };
  }

  onSnapshot(listener: SnapshotListener) {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  get running() {
    return this.#timer !== undefined;
  }

  /** The last snapshot taken. */
  get latest() {
    return this.#latest;
  }

  start() {
    if (this.#timer) return;
    this.process?.start();
    this.#lastTime = this.#clock();
    this.process?.sample();
    this.#timer = setInterval(() => this.sample(), this.intervalMs);
    this.#timer.unref?.();
  }

  stop() {
    clearInterval(this.#timer);
    this.#timer = undefined;
    this.process?.stop();
  }

  /** Take a snapshot now and hand it to the listeners. */
  sample(now = this.#clock()): MetricsSnapshot {
    const dtMs = this.#lastTime === undefined ? 0 : now - this.#lastTime;
    this.#lastTime = now;
    const previous = this.#previous;
    const next = new Map<string, number>();
    const perSec = (id: string, total: number) => {
      next.set(id, total);
      const before = previous.get(id);
      // first sample, or a total that went backwards (e.g. after a restore)
      if (before === undefined || dtMs <= 0 || total < before) return 0;
      return ((total - before) * 1_000) / dtMs;
    };

    const metrics: MetricValue[] = [];
    const tables = new Map<string, TableMetric>();
    const tableOf = (module: string, table: string) => {
      const id = `${module}.${table}`;
      let row = tables.get(id);
      if (!row) {
        row = {
          id,
          module,
          table,
          rows: 0,
          counted: false,
          writes: 0,
          writesPerSec: 0,
        };
        tables.set(id, row);
      }
      return row;
    };
    const writer: MetricsWriter = {
      counter: (component, name, total, unit = "") => {
        const id = `${component}.${name}`;
        metrics.push({
          id,
          component,
          name,
          kind: "counter",
          unit,
          value: total,
          rate: perSec(id, total),
        });
      },
      gauge: (component, name, value, unit = "") => {
        metrics.push({
          id: `${component}.${name}`,
          component,
          name,
          kind: "gauge",
          unit,
          value,
          rate: 0,
        });
      },
      timer: (component, name, timer, unit = "us") => {
        const id = `${component}.${name}`;
        const histogram = timer instanceof Histogram ? timer : timer.histogram;
        const { count } = histogram;
        const rate =
          timer instanceof Histogram
            ? dtMs > 0
              ? (count * 1_000) / dtMs
              : 0
            : perSec(id, timer.calls);
        metrics.push({
          id,
          component,
          name,
          kind: "timer",
          unit,
          value: count,
          rate,
          mean: histogram.mean,
          p50: histogram.percentile(0.5),
          p99: histogram.percentile(0.99),
          max: histogram.max,
        });
        histogram.reset();
      },
      timers: (registry) => {
        for (const { component, name, unit, timer } of registry.timers())
          writer.timer(component, name, timer, unit);
      },
      tableRows: (module, table, rows) => {
        tableOf(module, table).rows = rows;
      },
      tableWrites: (module, table, total) => {
        const row = tableOf(module, table);
        row.counted = true;
        row.writes = total;
        row.writesPerSec = perSec(`table:${row.id}`, total);
      },
    };

    for (const source of this.#sources) {
      try {
        source.collect(writer, now);
      } catch (err) {
        if (!this.#failed.has(source)) {
          this.#failed.add(source);
          this.#log(`metrics source ${source.name} failed: ${err}`);
        }
      }
    }
    this.#previous = next;

    const snapshot: MetricsSnapshot = {
      time: now,
      intervalMs: dtMs,
      process: this.process?.sample(),
      metrics,
      tables: [...tables.values()],
    };
    this.#latest = snapshot;
    for (const listener of this.#listeners) {
      try {
        listener(snapshot);
      } catch (err) {
        this.#log(`metrics listener failed: ${err}`);
      }
    }
    return snapshot;
  }
}
