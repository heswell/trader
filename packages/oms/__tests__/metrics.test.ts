import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  canAdminSim,
  createExchangeSimulator,
  ExchangeModule,
  SIM_ADMIN_ROLE,
} from "@heswell/exchange-sim";
import { MetricsCollector } from "@heswell/trading-metrics";
import {
  MetricsModule,
  vuuServerSource,
} from "@heswell/trading-metrics/server";
import { METRICS_MODULE } from "@heswell/trading-schemas";
import {
  ConfigFactory,
  createVuuServerApplication,
  type VuuServer,
  type VuuServerApplication,
  VuuUserWithAuthorizations,
} from "@heswell/vuu-server";
import { createOms } from "../src/engine/OmsService";
import { loadMetricsConfig } from "../src/metrics/config";
import {
  exchangeMetricsSource,
  omsMetricsSource,
} from "../src/metrics/tradingSources";
import { OmsModule } from "../src/modules/oms/OmsModule";
import { TradingRole } from "../src/permissions/access";
import { toPerfStatsSample } from "../src/perf/PerfStatsReporter";
import { VuuClient } from "./vuuClient";

const METRIC_COLUMNS = ["id", "component", "name", "kind", "value", "rate"];
const TABLE_COLUMNS = ["id", "rows", "counted", "writes", "writesPerSec"];
const PROCESS_COLUMNS = ["id", "pid", "cpuPct", "rssMb", "loopLagP99Ms"];

/** METRICS module end to end: sources -> collector -> tables -> viewports. */
describe("METRICS module over the Vuu protocol", () => {
  let application: VuuServerApplication;
  let server: VuuServer;
  const sim = createExchangeSimulator({
    config: { instruments: "AAPL.OQ,VOD.L", publishIntervalMs: 20 },
  });
  const oms = createOms(sim.gateway, {
    config: { flowRate: 0, markIntervalMs: 50 },
    rics: () => sim.books.map((b) => b.ric),
    log: () => {},
  });
  sim.timers.setMode("all");
  const collector = new MetricsCollector({ intervalMs: 50 });
  collector.register(exchangeMetricsSource(sim));
  collector.register(omsMetricsSource(oms));

  const config = ConfigFactory.fromFile(
    resolve(import.meta.dir, "../application.conf"),
    {
      env: {},
      overrides: { "vuu.websocket.port": 0, "vuu.https.port": 0 },
    },
  );
  const roles: Record<string, string[]> = {
    admin: [SIM_ADMIN_ROLE],
    alice: [TradingRole.Execute],
  };
  const clients: VuuClient[] = [];
  const login = async (name: string) => {
    const token = await VuuClient.fetchToken(
      `http://localhost:${server.restPort}${config.getString("vuu.auth.path")}`,
      name,
    );
    const client = await VuuClient.login(
      `ws://localhost:${server.webSocketPort}${config.getString("vuu.websocket.path")}`,
      token,
    );
    clients.push(client);
    return client;
  };

  beforeAll(async () => {
    application = createVuuServerApplication({
      authProviders: {
        credentials: {
          allowsEmptyPassword: true,
          authenticate: async (username) =>
            VuuUserWithAuthorizations(username, roles[username] ?? []),
        },
      },
      config,
      defaultHttpsPort: 0,
      defaultWebSocketPort: 0,
      modules: [
        ExchangeModule(sim),
        OmsModule(oms),
        MetricsModule(collector, {
          canView: (user) => canAdminSim(user, "auto"),
        }),
      ],
    });
    collector.register(vuuServerSource(() => application.server));
    await application.lifecycle.start();
    server = application.server;
  });

  afterAll(async () => {
    for (const client of clients) client.close();
    await application.lifecycle.stop();
  });

  test("the collector starts once the METRICS tables load", () => {
    expect(collector.running).toBe(true);
  });

  test("a sim admin sees metrics, table and process rows", async () => {
    const admin = await login("admin");
    const metricsVp = await admin.createViewport(
      METRICS_MODULE,
      "metrics",
      METRIC_COLUMNS,
    );
    const tablesVp = await admin.createViewport(
      METRICS_MODULE,
      "metricsTables",
      TABLE_COLUMNS,
    );
    const processVp = await admin.createViewport(
      METRICS_MODULE,
      "metricsProcess",
      PROCESS_COLUMNS,
    );

    const books = await admin.row(metricsVp, (r) => r.id === "exchange.books");
    expect(books).toMatchObject({ kind: "gauge", value: 2 });
    // the publisher flushes every 20 ms, so its counter climbs
    await admin.row(
      metricsVp,
      (r) => r.id === "publisher.flushes" && Number(r.rate) > 0,
    );
    await admin.row(
      metricsVp,
      (r) => r.id === "vuu.viewports" && Number(r.value) >= 3,
    );
    await admin.row(metricsVp, (r) => r.id === "oms.liveOrders");
    if ("getSessionStats" in server) {
      // vuu-server 4.5.0+ (trader upstream issue 91): the admin's own
      // session is sending rows
      await admin.row(
        metricsVp,
        (r) => r.id === "vuu.sessions" && Number(r.value) >= 1,
      );
      await admin.row(
        metricsVp,
        (r) => r.id === "vuu.rowsSent" && Number(r.rate) > 0,
      );
      const sendCycle = await admin.row(
        metricsVp,
        (r) => r.id === "vuu.sendCycle" && Number(r.value) > 0,
      );
      expect(sendCycle.kind).toBe("timer");
      const sessionsVp = await admin.createViewport(
        METRICS_MODULE,
        "metricsSessions",
        ["id", "user", "rowsSent"],
      );
      await admin.row(
        sessionsVp,
        (r) => r.user === "admin" && Number(r.rowsSent) > 0,
      );
    }
    // a timer row: the publisher's flush, timed on every call here
    const flush = await admin.row(
      metricsVp,
      (r) => r.id === "publisher.flush" && Number(r.value) > 0,
    );
    expect(flush.kind).toBe("timer");

    const prices = await admin.row(
      tablesVp,
      (r) => r.id === "EXCHANGE.prices" && Number(r.writes) > 0,
    );
    // every instrument in the universe has a prices row, not just the 2 active
    expect(Number(prices.rows)).toBeGreaterThan(2);
    expect(prices.counted).toBe(true);
    expect(
      await admin.row(tablesVp, (r) => r.id === "OMS.accounts"),
    ).toMatchObject({ counted: true });
    // tables nobody counts writes for still get a row count
    expect(
      await admin.row(tablesVp, (r) => r.id === "EXCHANGE.instruments"),
    ).toMatchObject({ counted: false, writes: 0 });

    const historyVp = await admin.createViewport(
      METRICS_MODULE,
      "metricsHistory",
      ["id", "metric", "component", "time", "value"],
    );
    const cpu = await admin.row(
      historyVp,
      (r) => r.metric === "process.cpuPct",
    );
    expect(cpu.component).toBe("process");
    expect(String(cpu.id)).toBe(`process.cpuPct|${cpu.time}`);

    const proc = await admin.row(processVp, (r) => r.id === "trading");
    expect(proc.pid).toBe(process.pid);
    expect(Number(proc.rssMb)).toBeGreaterThan(0);
  });

  test("a trader without sim-admin sees no rows", async () => {
    const alice = await login("alice");
    const vp = await alice.createViewport(
      METRICS_MODULE,
      "metrics",
      METRIC_COLUMNS,
    );
    await Bun.sleep(200);
    expect(alice.rowsOf(vp)).toEqual([]);
  });

  test("the perf stats line reads the same snapshot", () => {
    const snapshot = collector.sample();
    const line = toPerfStatsSample(snapshot);
    expect(line.pid).toBe(process.pid);
    expect(line.flushes).toBeGreaterThan(0);
    expect(line.priceUpdates).toBe(sim.publisher?.stats.priceUpdates ?? -1);
    expect(line.bookEvents).toBe(sim.bookEvents);
    expect(Object.keys(line.omsWrites).sort()).toEqual(
      Object.keys(oms.tables.writes).sort(),
    );
  });
});

describe("loadMetricsConfig", () => {
  const source = (values: Record<string, number>) => ({
    has: (key: string) => key in values,
    getString: (key: string) => String(values[key]),
    getNumber: (key: string) => values[key],
  });

  test("defaults, conf, env (env wins)", () => {
    const defaults = {
      enabled: 1,
      intervalMs: 1_000,
      timers: "sampled" as const,
      sampleEvery: 16,
      historySize: 300,
    };
    expect(loadMetricsConfig(undefined, {})).toEqual(defaults);
    expect(
      loadMetricsConfig(source({ "metrics.intervalMs": 500 }), {}),
    ).toEqual({ ...defaults, intervalMs: 500 });
    expect(
      loadMetricsConfig(source({ "metrics.enabled": 1 }), {
        TRADER_METRICS_ENABLED: "false",
        METRICS_INTERVAL_MS: "250",
        TRADER_METRICS_TIMERS: "all",
        METRICS_SAMPLE_EVERY: "64",
      }),
    ).toEqual({
      enabled: 0,
      intervalMs: 250,
      timers: "all" as const,
      sampleEvery: 64,
      historySize: 300,
    });
  });

  test("validation", () => {
    expect(() =>
      loadMetricsConfig(undefined, { METRICS_INTERVAL_MS: "abc" }),
    ).toThrow("not a number");
    expect(() =>
      loadMetricsConfig(undefined, { METRICS_INTERVAL_MS: "0" }),
    ).toThrow("must be > 0");
    expect(() =>
      loadMetricsConfig(undefined, { METRICS_TIMERS: "some" }),
    ).toThrow("metrics.timers must be one of off, sampled, all");
    expect(() =>
      loadMetricsConfig(undefined, { METRICS_SAMPLE_EVERY: "10" }),
    ).toThrow("power of two");
    expect(() =>
      loadMetricsConfig(undefined, { METRICS_HISTORY_SIZE: "-1" }),
    ).toThrow("metrics.historySize");
  });
});
