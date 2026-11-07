import { describe, expect, test } from "bun:test";
import { metricsModuleTables } from "@heswell/trading-schemas";
import { Histogram, MetricsCollector } from "../src";
import {
  type MetricsTable,
  type MetricsTableName,
  MetricsTablePublisher,
  vuuServerSource,
} from "../src/server";

type Row = (string | number | boolean)[];

/** In-memory stand-in for a vuu-server DataTable, counting writes. */
class FakeTable implements MetricsTable {
  readonly columnMap: Record<string, number>;
  readonly columns: readonly unknown[];
  readonly rows = new Map<string, Record<string, unknown>>();
  inserts = 0;
  updates = 0;

  constructor(name: MetricsTableName) {
    const def = metricsModuleTables[name];
    this.columns = def.columns;
    this.columnMap = Object.fromEntries(def.columns.map((c, i) => [c.name, i]));
  }

  #toValues(row: Row) {
    return Object.fromEntries(
      Object.entries(this.columnMap).map(([name, i]) => [name, row[i]]),
    );
  }

  insert(row: Row) {
    this.inserts++;
    const values = this.#toValues(row);
    this.rows.set(String(values.id), values);
  }

  update(rowIdx: number, row: Row) {
    this.updates++;
    const values = this.#toValues(row);
    if ([...this.rows.keys()][rowIdx] !== values.id) throw Error("bad rowIdx");
    this.rows.set(String(values.id), values);
  }

  rowIndexAtKey(key: string) {
    return [...this.rows.keys()].indexOf(key);
  }

  delete(key: string) {
    this.rows.delete(key);
  }
}

const setup = (historySize?: number) => {
  const collector = new MetricsCollector();
  const publisher = new MetricsTablePublisher({
    processName: "test",
    historySize,
  });
  const tables = {
    metricsProcess: new FakeTable("metricsProcess"),
    metrics: new FakeTable("metrics"),
    metricsTables: new FakeTable("metricsTables"),
    metricsHistory: new FakeTable("metricsHistory"),
  };
  for (const [name, table] of Object.entries(tables)) {
    publisher.attach(name as MetricsTableName, table);
  }
  collector.onSnapshot(publisher.publish);
  return { collector, tables };
};

describe("MetricsTablePublisher", () => {
  test("writes process, metric and table rows", () => {
    const { collector, tables } = setup();
    collector.register({
      name: "t",
      collect: (w) => {
        w.counter("exchange", "trades", 10);
        w.tableRows("EXCHANGE", "prices", 5);
        w.tableWrites("EXCHANGE", "prices", 7);
      },
    });
    collector.sample(1_000);

    const proc = tables.metricsProcess.rows.get("test");
    expect(proc?.pid).toBe(process.pid);
    expect(proc?.rssMb).toBeGreaterThan(0);
    expect(proc?.lastUpdate).toBe(1_000);
    expect(tables.metrics.rows.get("exchange.trades")).toMatchObject({
      component: "exchange",
      name: "trades",
      kind: "counter",
      value: 10,
      rate: 0,
      p99: 0,
    });
    expect(tables.metricsTables.rows.get("EXCHANGE.prices")).toMatchObject({
      module: "EXCHANGE",
      table: "prices",
      rows: 5,
      counted: true,
      writes: 7,
    });
  });

  test("unchanged rows are not rewritten", () => {
    const { collector, tables } = setup();
    let trades = 1;
    collector.register({
      name: "t",
      collect: (w) => {
        w.gauge("oms", "positions", 3);
        w.counter("exchange", "trades", trades);
      },
    });
    collector.sample(0);
    collector.sample(1_000); // trades rate 0 -> 0, value unchanged
    expect(tables.metrics.inserts).toBe(2);
    expect(tables.metrics.updates).toBe(0);
    trades = 5;
    collector.sample(2_000);
    expect(tables.metrics.updates).toBe(1);
    expect(tables.metrics.rows.get("exchange.trades")).toMatchObject({
      value: 5,
      rate: 4,
      lastUpdate: 2_000,
    });
    expect(tables.metrics.rows.get("oms.positions")?.lastUpdate).toBe(0);
  });
});

describe("metricsHistory", () => {
  const history = (table: FakeTable, metric: string) =>
    [...table.rows.values()]
      .filter((r) => r.metric === metric)
      .map((r) => [r.time, r.value, r.rate]);

  test("a row per metric per snapshot, the oldest dropped past historySize", () => {
    const { collector, tables } = setup(3);
    let trades = 0;
    collector.register({
      name: "t",
      collect: (w) => {
        w.counter("exchange", "trades", trades);
        w.tableWrites("EXCHANGE", "prices", trades * 2);
      },
    });
    for (let i = 0; i < 5; i++) {
      trades = i * 10;
      collector.sample(i * 1_000);
    }
    // rows are added even when the metrics row did not change
    expect(history(tables.metricsHistory, "exchange.trades")).toEqual([
      [2_000, 20, 10],
      [3_000, 30, 10],
      [4_000, 40, 10],
    ]);
    expect(
      tables.metricsHistory.rows.get("exchange.trades|4000"),
    ).toMatchObject({ component: "exchange", name: "trades", kind: "counter" });
    expect(history(tables.metricsHistory, "table.EXCHANGE.prices")).toEqual([
      [2_000, 40, 20],
      [3_000, 60, 20],
      [4_000, 80, 20],
    ]);
    const cpu = history(tables.metricsHistory, "process.cpuPct");
    expect(cpu.map(([time]) => time)).toEqual([2_000, 3_000, 4_000]);
    expect(
      tables.metricsHistory.rows.get("process.rssMb|4000")?.value,
    ).toBeGreaterThan(0);
  });

  test("timers keep their percentiles; historySize 0 keeps nothing", () => {
    const h = new Histogram();
    const { collector, tables } = setup();
    collector.register({
      name: "t",
      collect: (w) => w.timer("oms", "risk", h),
    });
    for (const v of [10, 20, 30]) h.record(v);
    collector.sample(1_000);
    expect(tables.metricsHistory.rows.get("oms.risk|1000")).toMatchObject({
      kind: "timer",
      unit: "us",
      value: 3,
      max: 30,
    });

    const none = setup(0);
    none.collector.register({
      name: "t",
      collect: (w) => w.counter("a", "b", 1),
    });
    none.collector.sample(0);
    expect(none.tables.metricsHistory.rows.size).toBe(0);
  });
});

describe("vuuServerSource", () => {
  test("viewports and per-table row counts", () => {
    const collector = new MetricsCollector({ process: false });
    const rowCounts: Record<string, number> = { prices: 3, fills: 9 };
    collector.register(
      vuuServerSource(() => ({
        viewPortContainer: { viewportCount: 4 },
        tableContainer: {
          getDefinedTables: () => [
            { module: "EXCHANGE", table: "prices" },
            { module: "OMS", table: "fills" },
          ],
          getTable: (name) => ({ rowCount: rowCounts[name] }),
        },
      })),
    );
    const snapshot = collector.sample(0);
    expect(snapshot.metrics).toMatchObject([
      { id: "vuu.viewports", kind: "gauge", value: 4 },
    ]);
    expect(snapshot.tables.map((t) => [t.id, t.rows])).toEqual([
      ["EXCHANGE.prices", 3],
      ["OMS.fills", 9],
    ]);
  });

  test("no server yet: nothing reported", () => {
    const collector = new MetricsCollector({ process: false });
    collector.register(vuuServerSource(() => undefined));
    expect(collector.sample(0).metrics).toEqual([]);
  });
});
