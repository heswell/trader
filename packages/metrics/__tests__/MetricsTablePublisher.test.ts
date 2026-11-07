import { describe, expect, test } from "bun:test";
import { metricsModuleTables } from "@heswell/trading-schemas";
import { MetricsCollector } from "../src";
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

  insert(row: Row) {
    this.inserts++;
    const values = Object.fromEntries(
      Object.entries(this.columnMap).map(([name, i]) => [name, row[i]]),
    );
    this.rows.set(String(values.id), values);
  }

  updateByKey(key: string, values: Record<string, unknown>) {
    this.updates++;
    this.rows.set(key, { ...this.rows.get(key), ...values });
  }

  rowIndexAtKey(key: string) {
    return this.rows.has(key) ? 0 : -1;
  }
}

const setup = () => {
  const collector = new MetricsCollector();
  const publisher = new MetricsTablePublisher("test");
  const tables = {
    metricsProcess: new FakeTable("metricsProcess"),
    metrics: new FakeTable("metrics"),
    metricsTables: new FakeTable("metricsTables"),
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
