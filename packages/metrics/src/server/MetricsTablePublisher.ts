import {
  type MetricsHistoryRow,
  metricsHistoryKey,
  type MetricsProcessRow,
  type MetricRow,
  type MetricsTableRow,
  metricsModuleTables,
  type TableDefinition,
  toRowArray,
} from "@heswell/trading-schemas";
import type { MetricsSnapshot } from "../MetricsCollector";

type RowValue = string | number | boolean;

/**
 * Structural subset of a vuu-server DataTable (and of an engine-local
 * table, so the test data can publish the same rows in the browser).
 */
export interface MetricsTable {
  readonly columnMap: Record<string, number>;
  readonly columns: readonly unknown[];
  insert(row: RowValue[]): unknown;
  update(rowIdx: number, row: RowValue[]): unknown;
  rowIndexAtKey(key: string): number;
  delete(key: string): unknown;
}

export interface MetricsTablePublisherOptions {
  /** Key of the metricsProcess row (default "trading"). */
  processName?: string;
  /** metricsHistory rows kept per metric (default 300; 0 = no history). */
  historySize?: number;
}

/** Process values kept in metricsHistory (component "process"). */
const PROCESS_HISTORY = [
  ["cpuPct", "%"],
  ["rssMb", "MB"],
  ["heapUsedMb", "MB"],
  ["loopLagP99Ms", "ms"],
  ["loopLagMaxMs", "ms"],
] as const;

export type MetricsTableName = keyof typeof metricsModuleTables;

const MB = 1024 * 1024;
const mb = (bytes: number) => Math.round((bytes / MB) * 10) / 10;
const r3 = (value: number) => Math.round(value * 1_000) / 1_000;

/**
 * Writes collector snapshots to the METRICS tables. A metricsProcess,
 * metrics or metricsTables row is written only when one of its values
 * changed, so its lastUpdate is when it last changed. metricsHistory gets a
 * row per metric per snapshot, and drops a metric's oldest row once it holds
 * `historySize`.
 */
export class MetricsTablePublisher {
  readonly #tables: Partial<Record<MetricsTableName, MetricsTable>> = {};
  /** Last values written, per table and key, without lastUpdate. */
  readonly #written = new Map<string, string>();
  /** metricsHistory keys per metric, oldest first. */
  readonly #history = new Map<string, string[]>();
  readonly processName: string;
  readonly historySize: number;

  constructor({
    processName = "trading",
    historySize = 300,
  }: MetricsTablePublisherOptions = {}) {
    if (!(historySize >= 0)) throw Error("metrics historySize must be >= 0");
    this.processName = processName;
    this.historySize = historySize;
  }

  attach(name: MetricsTableName, table: MetricsTable) {
    this.#tables[name] = table;
  }

  get attached() {
    return Object.keys(this.#tables) as MetricsTableName[];
  }

  publish = (snapshot: MetricsSnapshot) => {
    const { time, process } = snapshot;
    if (process) {
      const row: MetricsProcessRow = {
        id: this.processName,
        pid: process.pid,
        started: process.started,
        uptimeS: Math.round(process.uptimeS),
        cpuPct: Math.round(process.cpuPct * 10) / 10,
        rssMb: mb(process.rssBytes),
        heapUsedMb: mb(process.heapUsedBytes),
        heapTotalMb: mb(process.heapTotalBytes),
        externalMb: mb(process.externalBytes),
        loopLagP50Ms: r3(process.loopLagP50Ms),
        loopLagP99Ms: r3(process.loopLagP99Ms),
        loopLagMaxMs: r3(process.loopLagMaxMs),
        lastUpdate: time,
      };
      this.#write("metricsProcess", row);
      for (const [column, unit] of PROCESS_HISTORY) {
        this.#addHistory({
          metric: `process.${column}`,
          component: "process",
          name: column,
          kind: "gauge",
          unit,
          time,
          value: row[column],
          rate: 0,
        });
      }
    }
    for (const m of snapshot.metrics) {
      const row: MetricRow = {
        id: m.id,
        component: m.component,
        name: m.name,
        kind: m.kind,
        unit: m.unit,
        value: r3(m.value),
        rate: r3(m.rate),
        mean: r3(m.mean ?? 0),
        p50: r3(m.p50 ?? 0),
        p99: r3(m.p99 ?? 0),
        max: r3(m.max ?? 0),
        lastUpdate: time,
      };
      this.#write("metrics", row);
      this.#addHistory({
        metric: m.id,
        component: m.component,
        name: m.name,
        kind: m.kind,
        unit: m.unit,
        time,
        value: row.value,
        rate: row.rate,
        ...(m.kind === "timer"
          ? { p50: row.p50, p99: row.p99, max: row.max }
          : {}),
      });
    }
    for (const t of snapshot.tables) {
      const row: MetricsTableRow = {
        id: t.id,
        module: t.module,
        table: t.table,
        rows: t.rows,
        counted: t.counted,
        writes: t.writes,
        writesPerSec: r3(t.writesPerSec),
        lastUpdate: time,
      };
      this.#write("metricsTables", row);
      if (t.counted) {
        this.#addHistory({
          metric: `table.${t.id}`,
          component: "table",
          name: t.id,
          kind: "counter",
          unit: "writes",
          time,
          value: t.writes,
          rate: row.writesPerSec,
        });
      }
    }
  };

  #addHistory(
    values: Omit<MetricsHistoryRow, "id" | "p50" | "p99" | "max"> &
      Partial<Pick<MetricsHistoryRow, "p50" | "p99" | "max">>,
  ) {
    const table = this.#tables.metricsHistory;
    if (!table || this.historySize === 0) return;
    const id = metricsHistoryKey(values.metric, values.time);
    let keys = this.#history.get(values.metric);
    if (!keys) {
      keys = [];
      this.#history.set(values.metric, keys);
    }
    if (keys.at(-1) === id) return; // two snapshots in one ms
    table.insert(this.#row(table, "metricsHistory", { id, ...values }));
    keys.push(id);
    if (keys.length > this.historySize) table.delete(keys.shift() as string);
  }

  /** `values` as a row in the table's column order. */
  #row(
    table: MetricsTable,
    name: MetricsTableName,
    values: Record<string, RowValue | undefined>,
  ) {
    const def: TableDefinition = metricsModuleTables[name];
    const ordered = toRowArray(def, values as never);
    const row: RowValue[] = new Array(table.columns.length).fill(0);
    def.columns.forEach(({ name: column }, i) => {
      row[table.columnMap[column]] = ordered[i];
    });
    return row;
  }

  #write(
    name: MetricsTableName,
    values: { id: string; lastUpdate: number } & Record<string, RowValue>,
  ) {
    const table = this.#tables[name];
    if (!table) return;
    const { lastUpdate: _, ...compared } = values;
    const writtenKey = `${name}|${values.id}`;
    const signature = JSON.stringify(compared);
    if (this.#written.get(writtenKey) === signature) return;
    this.#written.set(writtenKey, signature);
    const row = this.#row(table, name, values);
    const rowIdx = table.rowIndexAtKey(values.id);
    if (rowIdx === -1) table.insert(row);
    else table.update(rowIdx, row);
  }
}
