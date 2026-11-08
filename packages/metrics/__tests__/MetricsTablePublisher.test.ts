import { describe, expect, test } from "bun:test";
import { metricsModuleTables } from "@heswell/trading-schemas";
import { Histogram, MetricsCollector } from "../src";
import {
  type MetricsTable,
  type MetricsTableName,
  MetricsTablePublisher,
  type VuuSendCycle,
  type VuuServerStats,
  type VuuSessionStats,
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
    metricsSessions: new FakeTable("metricsSessions"),
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

  test("sessions, outbound queues and send cycles (vuu-server issue 91)", () => {
    const collector = new MetricsCollector({ process: false });
    const session = (
      sessionId: string,
      queueLength: number,
      rowsQueued: number,
      rowsCoalesced: number,
      rowsSent: number,
    ): VuuSessionStats => ({
      sessionId,
      user: `user-${sessionId}`,
      connectedAt: 1_000,
      queueLength,
      rowsQueued,
      rowsCoalesced,
      rowsSent,
      rowsDropped: 0,
      messagesSent: rowsSent / 10,
      charsSent: rowsSent * 1024,
    });
    let sessions = [session("a", 5, 100, 20, 80), session("b", 1, 10, 0, 10)];
    const cycleListeners = new Set<(cycle: VuuSendCycle) => void>();
    const server: VuuServerStats = {
      viewPortContainer: { viewportCount: 2 },
      tableContainer: {
        getDefinedTables: () => [],
        getTable: () => ({ rowCount: 0 }),
      },
      get sessionCount() {
        return sessions.length;
      },
      getSessionStats: () => sessions,
      onSendCycle: (listener) => {
        cycleListeners.add(listener);
        return () => cycleListeners.delete(listener);
      },
    };
    collector.register(vuuServerSource(() => server));
    const byId = (snapshot: ReturnType<typeof collector.sample>) =>
      Object.fromEntries(snapshot.metrics.map((m) => [m.id, m]));

    const first = byId(collector.sample(0));
    expect(first["vuu.sessions"].value).toBe(2);
    expect(first["vuu.queuedRows"].value).toBe(6);
    expect(first["vuu.queuedRowsMax"].value).toBe(5);
    expect(first["vuu.rowsQueued"]).toMatchObject({
      kind: "counter",
      value: 110,
    });
    expect(first["vuu.rowsSent"].value).toBe(90);
    expect(first["vuu.messagesSent"].value).toBe(9);
    expect(first["vuu.kbSent"].value).toBe(90);
    expect(first["vuu.coalescedPct"].value).toBeCloseTo((100 * 20) / 110);
    expect(first["vuu.sendCycle"]).toMatchObject({ kind: "timer", value: 0 });
    expect(cycleListeners.size).toBe(1);

    for (const durationMs of [1, 2, 4]) {
      for (const listener of cycleListeners) listener({ durationMs });
    }
    // b closes; a sends 100 more rows (50 coalesced of 200 queued); c opens
    sessions = [session("a", 0, 300, 70, 180), session("c", 0, 10, 0, 10)];
    const second = byId(collector.sample(1000));
    expect(second["vuu.sessions"].value).toBe(2);
    // totals keep b's rows and add the changes since the last read
    expect(second["vuu.rowsQueued"]).toMatchObject({ value: 320, rate: 210 });
    expect(second["vuu.rowsSent"]).toMatchObject({ value: 200, rate: 110 });
    expect(second["vuu.coalescedPct"].value).toBeCloseTo((100 * 50) / 210);
    expect(second["vuu.sendCycle"]).toMatchObject({ value: 3, max: 4000 });
    // still one listener
    expect(cycleListeners.size).toBe(1);
  });

  test("a metricsSessions row per session, removed when it closes", () => {
    const { collector, tables } = setup();
    const session = (
      sessionId: string,
      rowsQueued: number,
      rowsCoalesced: number,
      rowsSent: number,
    ): VuuSessionStats => ({
      sessionId,
      user: `user-${sessionId}`,
      connectedAt: 500,
      queueLength: 3,
      rowsQueued,
      rowsCoalesced,
      rowsSent,
      rowsDropped: 1,
      messagesSent: rowsSent / 10,
      charsSent: rowsSent * 1024,
    });
    let sessions = [session("a", 100, 0, 100), session("b", 10, 0, 10)];
    collector.register(
      vuuServerSource(() => ({
        viewPortContainer: { viewportCount: 0 },
        tableContainer: {
          getDefinedTables: () => [],
          getTable: () => ({ rowCount: 0 }),
        },
        getSessionStats: () => sessions,
      })),
    );
    collector.sample(0);
    expect([...tables.metricsSessions.rows.keys()]).toEqual(["a", "b"]);
    expect(tables.metricsSessions.rows.get("a")).toMatchObject({
      user: "user-a",
      connected: 500,
      queueLength: 3,
      rowsSent: 100,
      rowsSentPerSec: 0, // first sample
    });

    // a queues 200 (50 coalesced) and sends 150 in a second; b closes
    sessions = [session("a", 300, 50, 250)];
    collector.sample(1000);
    expect([...tables.metricsSessions.rows.keys()]).toEqual(["a"]);
    expect(tables.metricsSessions.rows.get("a")).toMatchObject({
      rowsQueuedPerSec: 200,
      rowsSentPerSec: 150,
      coalescedPct: 25,
      messagesPerSec: 15,
      kbPerSec: 150,
      rowsSent: 250,
      rowsDropped: 1,
      lastUpdate: 1000,
    });

    // b logs in again with the same id: a new row
    sessions = [session("a", 300, 50, 250), session("b", 5, 0, 5)];
    collector.sample(2000);
    expect([...tables.metricsSessions.rows.keys()]).toEqual(["a", "b"]);
  });

  test("no session stats in vuu-server 4.4.0: viewports and tables only", () => {
    const collector = new MetricsCollector({ process: false });
    collector.register(
      vuuServerSource(() => ({
        viewPortContainer: { viewportCount: 1 },
        tableContainer: {
          getDefinedTables: () => [],
          getTable: () => ({ rowCount: 0 }),
        },
      })),
    );
    expect(collector.sample(0).metrics.map(({ id }) => id)).toEqual([
      "vuu.viewports",
    ]);
  });

  test("no server yet: nothing reported", () => {
    const collector = new MetricsCollector({ process: false });
    collector.register(vuuServerSource(() => undefined));
    expect(collector.sample(0).metrics).toEqual([]);
  });
});
