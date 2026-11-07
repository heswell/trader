import {
  type MetricsProcessRow,
  type MetricRow,
  type MetricsTableRow,
  metricsModuleTables,
  type TableDefinition,
  toRowArray,
} from "@heswell/trading-schemas";
import type { MetricsSnapshot } from "../MetricsCollector";

type RowValue = string | number | boolean;

/** Structural subset of a vuu-server DataTable. */
export interface MetricsTable {
  readonly columnMap: Record<string, number>;
  readonly columns: readonly unknown[];
  insert(row: RowValue[]): unknown;
  updateByKey(key: string, values: Record<string, RowValue>): unknown;
  rowIndexAtKey(key: string): number;
}

export type MetricsTableName = keyof typeof metricsModuleTables;

const MB = 1024 * 1024;
const mb = (bytes: number) => Math.round((bytes / MB) * 10) / 10;
const r3 = (value: number) => Math.round(value * 1_000) / 1_000;

/**
 * Writes collector snapshots to the METRICS tables. A row is written only
 * when one of its values changed, so its lastUpdate is when it last changed.
 */
export class MetricsTablePublisher {
  readonly #tables: Partial<Record<MetricsTableName, MetricsTable>> = {};
  /** Last values written, per table and key, without lastUpdate. */
  readonly #written = new Map<string, string>();
  readonly processName: string;

  constructor(processName = "trading") {
    this.processName = processName;
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
    }
  };

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
    if (table.rowIndexAtKey(values.id) === -1) {
      const def: TableDefinition = metricsModuleTables[name];
      const ordered = toRowArray(def, values as never);
      const row: RowValue[] = new Array(table.columns.length).fill(0);
      def.columns.forEach(({ name: column }, i) => {
        row[table.columnMap[column]] = ordered[i];
      });
      table.insert(row);
    } else {
      table.updateByKey(values.id, values);
    }
  }
}
