import {
  type Config,
  ConfigFactory,
  createConfiguredAuthProviders,
  createVuuServerApplication,
  getLogger,
} from "@heswell/vuu-server";
import {
  canAdminSim,
  createExchangeSimulator,
  ExchangeModule,
  loadExchangeSimConfig,
  type SimPermissionMode,
} from "@heswell/exchange-sim";
import { MetricsCollector } from "@heswell/trading-metrics";
import {
  MetricsModule,
  vuuServerSource,
} from "@heswell/trading-metrics/server";
import { loadOmsConfig } from "./config";
import { createOms } from "./engine/OmsService";
import { loadMetricsConfig } from "./metrics/config";
import {
  exchangeMetricsSource,
  omsMetricsSource,
} from "./metrics/tradingSources";
import { OmsNotificationModule } from "./modules/notifications/OmsNotificationModule";
import { OmsModule } from "./modules/oms/OmsModule";
import { startPerfStatsReporter } from "./perf/PerfStatsReporter";
import { createTradingPersistence, loadPersistenceConfig } from "./persistence";

/**
 * Stand-alone trading server: EXCHANGE + OMS in one VuuServer (auth mode and
 * ports come from application.conf).
 */
export default async function main(
  config: Config = ConfigFactory.load(),
  {
    persistenceBaseDir,
  }: {
    /** Base of a relative persistence.dir (default: the cwd). */
    persistenceBaseDir?: string;
  } = {},
) {
  const sim = createExchangeSimulator({
    config: loadExchangeSimConfig(config),
  });
  const oms = createOms(sim.gateway, {
    config: loadOmsConfig(config),
    rics: () => sim.books.map((book) => book.ric),
    logger: getLogger("trader.oms"),
  });
  // Restore persisted exchange + OMS state before the modules attach their
  // tables (TableSink buffers the rows) and start the simulator / flow.
  const persistenceLogger = getLogger("trader.persistence");
  const persistence = createTradingPersistence({
    config: loadPersistenceConfig(config),
    sim,
    engine: oms.engine,
    baseDir: persistenceBaseDir,
    log: (message) => persistenceLogger.info(message),
  });
  const recovery = persistence.recover();
  persistence.start();
  let shutDown = false;
  const shutdown = () => {
    if (shutDown) return;
    shutDown = true;
    try {
      persistence.close();
      persistenceLogger.info("final snapshot written");
    } catch (err) {
      persistenceLogger.error(`final snapshot failed: ${err}`);
    }
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  process.once("beforeExit", shutdown);

  // METRICS tables (docs/metrics.md). The perf harness's stats file reads
  // the same collector, so it runs whenever either is on.
  const metricsConfig = loadMetricsConfig(config);
  const statsFile = process.env.TRADER_PERF_STATS_FILE;
  const metricsLogger = getLogger("trader.metrics");
  const metrics = new MetricsCollector({
    intervalMs: Number(
      (statsFile && process.env.TRADER_PERF_STATS_INTERVAL_MS) ||
        metricsConfig.intervalMs,
    ),
    log: (message) => metricsLogger.warn(message),
  });
  metrics.register(exchangeMetricsSource(sim));
  metrics.register(omsMetricsSource(oms));
  const permissionMode = sim.config.permissionMode as SimPermissionMode;

  const application = createVuuServerApplication({
    authProviders: createConfiguredAuthProviders(config),
    config,
    defaultHttpsPort: 8447,
    defaultWebSocketPath: "/websocket-trading",
    defaultWebSocketPort: 8095,
    // EXCHANGE first: the positionPrices join needs the prices table.
    modules: [
      ExchangeModule(sim),
      OmsModule(oms),
      OmsNotificationModule(oms),
      ...(metricsConfig.enabled
        ? [
            MetricsModule(metrics, {
              canView: (user) => canAdminSim(user, permissionMode),
            }),
          ]
        : []),
    ],
  });
  metrics.register(vuuServerSource(() => application.server));
  await application.start();
  // perf harness hook (packages/perf ws-load); off unless the env var is set
  const stopPerfStats = statsFile
    ? startPerfStatsReporter(statsFile, metrics)
    : undefined;
  if (statsFile) metrics.start();
  return {
    application,
    sim,
    oms,
    persistence,
    recovery,
    metrics,
    stopPerfStats,
  };
}
