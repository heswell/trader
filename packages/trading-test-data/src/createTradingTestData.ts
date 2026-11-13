import {
  type ExchangeAdminRpcName,
  type ExchangeSimConfig,
  ExchangeSimulator,
  handleExchangeAdminRpc,
  handleTimeSeriesRpc,
  type TimeSeriesRpcName,
  ManualClock,
  systemClock,
} from "@heswell/exchange-sim/engine";
import {
  type ClientAdminRpcName,
  connectClientFlowToSim,
  exchangeMetricsSource,
  handleClientAdminRpc,
  handleOmsRpc,
  handleOrderEntryEditCell,
  handleOrderEntryRpc,
  type OmsConfig,
  type OmsRpcName,
  OmsService,
  omsMetricsSource,
  type OmsTableName,
  type OrderEntryRpcName,
  type TradingUser,
} from "@heswell/oms/engine";
import { canAdminSim } from "@heswell/exchange-sim/engine";
import {
  CLIENT_ADMIN_RPC_NAMES,
  EXCHANGE_ADMIN_RPC_NAMES,
  EXCHANGE_QUERY_RPC_NAMES,
  EXCHANGE_MODULE,
  exchangeTables,
  instrumentPrices,
  METRICS_MODULE,
  metricsModuleTables,
  OMS_MODULE,
  OMS_RPC_NAMES,
  omsTables,
  ORDER_ENTRY_RPC_NAMES,
  orderEntryPrices,
  type JoinDefinition,
  positionPrices,
  type RpcName,
  type TableDefinition,
  toTableSchema,
} from "@heswell/trading-schemas";
import {
  AllowAllPermissionFilter,
  createJoinTable,
  createLocalEngine,
  getCurrentUser,
  type LocalEngine,
  PermissionFilter,
  type PermissionFunction,
  type RpcService,
  Table,
} from "@heswell/vuu-data-engine-local";
import type { TableSchema } from "@vuu-ui/vuu-data-types";
import type { RpcResult } from "@vuu-ui/vuu-protocol-types";
import { MetricsCollector } from "@heswell/trading-metrics";
import {
  type MetricsTableName,
  MetricsTablePublisher,
} from "@heswell/trading-metrics/publish";
import { parentOrdersEditHooks } from "./modules/parentOrdersEditHooks";
import { TradingLocalModule } from "./modules/TradingLocalModule";
import { visualLinksFor } from "./modules/visualLinks";

export type ExchangeTableName =
  | keyof typeof exchangeTables
  | "instrumentPrices";
export type OmsLocalTableName =
  | OmsTableName
  | "positionPrices"
  | "orderEntryPrices";
export type TradingLocalTableName =
  | ExchangeTableName
  | OmsLocalTableName
  | MetricsTableName;
export type { MetricsTableName };

export const EXCHANGE_TABLE_NAMES: readonly ExchangeTableName[] = [
  "instruments",
  "prices",
  "depth",
  "trades",
  "bars",
  "bookSamples",
  "bookOrders",
  "bookEvents",
  "simBooks",
  "bots",
  "botParams",
  "simSamples",
  "botHistory",
  "botFills",
  "simEvents",
  "scenarios",
  "scenarioRuns",
  "simSession",
  "timeSeriesBuckets",
  "instrumentPrices",
];
export const OMS_TABLE_NAMES: readonly OmsLocalTableName[] = [
  "accounts",
  "parentOrders",
  "childOrders",
  "fills",
  "positions",
  "pnlHistory",
  "accountPnlHistory",
  "clientBots",
  "clientBotParams",
  "orderEntry",
  "positionPrices",
  "orderEntryPrices",
];

export const METRICS_TABLE_NAMES: readonly MetricsTableName[] = [
  "metricsProcess",
  "metrics",
  "metricsTables",
  "metricsHistory",
  "metricsSessions",
];

/**
 * Browser defaults: lighter than the server (50 instruments, 200 bars per
 * series) so the showcase stays responsive; everything else is the server
 * default.
 */
export const LOCAL_EXCHANGE_DEFAULTS: Partial<ExchangeSimConfig> = {
  activeInstruments: 50,
  barHistory: 200,
  // 2 days of 1 s mid / spread (172,800 points per field) for at most 4
  // instruments at once: about 14 MB each
  timeSeriesHistoryHours: 48,
  // no market impact: UI tests and the showcase keep their exact prices
  impactVolShare: 0,
  // futures (front and next quarter) on two stocks and the synthetic US
  // tech index (which brings its constituents' books)
  futures: "AAPL.OQ,VOD.L,STECH",
};

export interface TradingTestDataOptions {
  /**
   * Seed for both the exchange simulator and the OMS background flow. The
   * same seed (with a manual clock) reproduces the same market and orders.
   */
  seed?: number;
  /** Exchange-sim overrides (see packages/exchange-sim/README.md). */
  exchange?: Partial<ExchangeSimConfig>;
  /** OMS overrides (see packages/oms/README.md), e.g. `{ flowRate: 0 }`. */
  oms?: Partial<OmsConfig>;
  /**
   * When set, time only advances through `advance(ms)`: no timers run and
   * the data is fully deterministic. Pass `true` or your own ManualClock.
   */
  manualClock?: boolean | ManualClock;
  /**
   * When the sim/OMS timers start: `"on-subscribe"` (default) when the first
   * data source is created, `true` immediately, `false` only via `start()`.
   * Ignored (always false) with a manual clock.
   */
  autoStart?: boolean | "on-subscribe";
}

export interface TradingTestData {
  readonly exchange: TradingLocalModule<ExchangeTableName>;
  readonly oms: TradingLocalModule<OmsLocalTableName>;
  /**
   * The METRICS tables, from the sim and OMS sources (no process row: the
   * browser has no process stats). Snapshots are taken once a second while
   * running, and at the end of every `advance()`.
   */
  readonly metrics: TradingLocalModule<MetricsTableName>;
  readonly metricsCollector: MetricsCollector;
  /** The isolated engine the modules are registered with. */
  readonly engine: LocalEngine;
  readonly sim: ExchangeSimulator;
  readonly omsService: OmsService;
  /** TableSchemas (identical to the server's TABLE_META_RESP), by table name. */
  readonly schemas: Record<TradingLocalTableName, TableSchema>;
  /** Present when created with `manualClock`. */
  readonly clock?: ManualClock;
  readonly running: boolean;
  /** Start the exchange step/flush and OMS flow/mark timers. */
  start(): void;
  stop(): void;
  /**
   * Deterministic time step (manual clock only): advances the clock in
   * `botStepMs` slices, stepping the exchange and the OMS flow, then
   * publishes and marks positions (taking a P&L history sample when due).
   */
  advance(ms: number): void;
  /**
   * Invoke an RPC directly, as `user` (default: engine-local current user),
   * exactly as a viewport RPC would be handled.
   */
  rpc(rpcName: RpcName, params: object, user?: TradingUser): RpcResult;
  /** Stop timers and dispose the sim, the OMS and the local engine. */
  dispose(): void;
}

const tableFor = (def: TableDefinition | JoinDefinition) =>
  new Table(toTableSchema(def));

// Both trading joins use the same column on each side (ric/ric), which is
// what createJoinTable expects.
const joinTableFor = (def: JoinDefinition, base: Table, join: Table) => {
  if (def.left !== def.right) {
    throw Error(
      `[trading-test-data] ${def.name}: createJoinTable needs left === right (${def.left}/${def.right})`,
    );
  }
  // The module that publishes the join destroys it (detaching it from its
  // sources) when the engine disposes the module.
  return createJoinTable(
    { module: def.module, table: def.name },
    base,
    join,
    def.left,
    {
      schema: toTableSchema(def),
      joinType: def.type === "InnerJoin" ? "inner" : "leftOuter",
    },
  );
};

const isExchangeRpc = (name: string): name is ExchangeAdminRpcName =>
  (EXCHANGE_ADMIN_RPC_NAMES as readonly string[]).includes(name);
const isTimeSeriesRpc = (name: string): name is TimeSeriesRpcName =>
  (EXCHANGE_QUERY_RPC_NAMES as readonly string[]).includes(name);
const isOmsRpc = (name: string): name is OmsRpcName =>
  (OMS_RPC_NAMES as readonly string[]).includes(name);
const isOrderEntryRpc = (name: string): name is OrderEntryRpcName =>
  (ORDER_ENTRY_RPC_NAMES as readonly string[]).includes(name);
const isClientAdminRpc = (name: string): name is ClientAdminRpcName =>
  (CLIENT_ADMIN_RPC_NAMES as readonly string[]).includes(name);

const forEachTable = <T extends string, V>(
  names: readonly T[],
  value: (name: T) => V,
) =>
  Object.fromEntries(names.map((name) => [name, value(name)])) as Record<T, V>;

/**
 * Create the EXCHANGE and OMS engine-local modules, backed by the real
 * @heswell/exchange-sim and @heswell/oms engines running in the browser.
 * Each instance has its own engine-local LocalEngine, so several can be live
 * at once.
 */
export const createTradingTestData = ({
  seed,
  exchange: exchangeConfig = {},
  oms: omsConfig = {},
  manualClock,
  autoStart = "on-subscribe",
}: TradingTestDataOptions = {}): TradingTestData => {
  const clock =
    manualClock instanceof ManualClock
      ? manualClock
      : manualClock
        ? new ManualClock()
        : undefined;
  const now = clock?.now ?? systemClock;

  const sim = new ExchangeSimulator({
    config: {
      ...LOCAL_EXCHANGE_DEFAULTS,
      ...(seed === undefined ? {} : { seed }),
      ...exchangeConfig,
    },
    clock: now,
  });
  const omsService = new OmsService(sim.gateway, {
    config: { ...(seed === undefined ? {} : { seed }), ...omsConfig },
    rics: () => sim.books.map((book) => book.ric),
    clock: now,
  });
  // before the EXCHANGE tables attach, so `scenarios` lists the client ones
  connectClientFlowToSim(omsService, sim);

  // Metrics: the same sources as the server; every timed call is timed
  // (the load here is light).
  const metricsCollector = new MetricsCollector({ process: false, clock: now });
  sim.timers.setMode("all");
  omsService.engine.timers.setMode("all");
  metricsCollector.register(exchangeMetricsSource(sim));
  metricsCollector.register(omsMetricsSource(omsService));

  // ------------------------------------------------------------ tables
  const instruments = tableFor(exchangeTables.instruments);
  const prices = tableFor(exchangeTables.prices);
  const depth = tableFor(exchangeTables.depth);
  const trades = tableFor(exchangeTables.trades);
  const bars = tableFor(exchangeTables.bars);
  const bookSamples = tableFor(exchangeTables.bookSamples);
  const bookOrders = tableFor(exchangeTables.bookOrders);
  const bookEvents = tableFor(exchangeTables.bookEvents);
  const simBooks = tableFor(exchangeTables.simBooks);
  const bots = tableFor(exchangeTables.bots);
  const botParams = tableFor(exchangeTables.botParams);
  const simSamples = tableFor(exchangeTables.simSamples);
  const botHistory = tableFor(exchangeTables.botHistory);
  const botFills = tableFor(exchangeTables.botFills);
  const simEvents = tableFor(exchangeTables.simEvents);
  const scenarios = tableFor(exchangeTables.scenarios);
  const scenarioRuns = tableFor(exchangeTables.scenarioRuns);
  const simSession = tableFor(exchangeTables.simSession);
  const timeSeriesBuckets = tableFor(exchangeTables.timeSeriesBuckets);
  const omsTableMap = forEachTable(
    Object.keys(omsTables) as OmsTableName[],
    (name) => tableFor(omsTables[name]),
  );
  const instrumentPricesJoin = joinTableFor(
    instrumentPrices,
    instruments,
    prices,
  );
  const positionPricesJoin = joinTableFor(
    positionPrices,
    omsTableMap.positions,
    prices,
  );

  const orderEntryPricesJoin = joinTableFor(
    orderEntryPrices,
    omsTableMap.orderEntry,
    prices,
  );

  sim.attachTables({
    instruments: instruments.engineTable,
    prices: prices.engineTable,
    depth: depth.engineTable,
    trades: trades.engineTable,
    bars: bars.engineTable,
    bookSamples: bookSamples.engineTable,
    bookOrders: bookOrders.engineTable,
    bookEvents: bookEvents.engineTable,
    simBooks: simBooks.engineTable,
    bots: bots.engineTable,
    botParams: botParams.engineTable,
    simSamples: simSamples.engineTable,
    botHistory: botHistory.engineTable,
    botFills: botFills.engineTable,
    simEvents: simEvents.engineTable,
    scenarios: scenarios.engineTable,
    scenarioRuns: scenarioRuns.engineTable,
    simSession: simSession.engineTable,
    timeSeriesBuckets: timeSeriesBuckets.engineTable,
  });
  for (const name of Object.keys(omsTableMap) as OmsTableName[]) {
    omsService.tables.attach(name, omsTableMap[name].engineTable);
  }

  // ------------------------------------------------------------ lifecycle
  let running = false;
  let algoElapsed = 0;
  const start = () => {
    if (running || clock) return;
    running = true;
    sim.start();
    omsService.start();
    metricsCollector.start();
  };
  const stop = () => {
    running = false;
    sim.stop();
    omsService.stop();
    metricsCollector.stop();
  };
  const onCreateDataSource =
    autoStart === "on-subscribe" && !clock ? start : undefined;

  // ------------------------------------------------------------ rpc
  const rpc = (
    rpcName: RpcName,
    params: object,
    user: TradingUser = getCurrentUser(),
  ): RpcResult => {
    if (isOmsRpc(rpcName))
      return handleOmsRpc(omsService, rpcName, params, user);
    if (isOrderEntryRpc(rpcName))
      return handleOrderEntryRpc(omsService, rpcName, params, user);
    if (isClientAdminRpc(rpcName))
      return handleClientAdminRpc(omsService, rpcName, params, user);
    if (isExchangeRpc(rpcName))
      return handleExchangeAdminRpc(sim, rpcName, params, user.name);
    if (isTimeSeriesRpc(rpcName))
      return handleTimeSeriesRpc(sim, rpcName, params, user.name);
    return {
      type: "ERROR_RESULT",
      errorMessage: `INVALID_REQUEST: unknown rpc ${rpcName}`,
    };
  };

  const rpcServices = (
    rpcNames: readonly RpcName[],
    module: () => Pick<TradingLocalModule<string>, "userForViewport">,
  ): RpcService[] =>
    rpcNames.map((rpcName) => ({
      rpcName,
      service: async (request) => {
        const user =
          request.context.type === "VIEWPORT_CONTEXT"
            ? module().userForViewport(request.context.viewPortId)
            : getCurrentUser();
        return rpc(rpcName, request.params, user) as Awaited<
          ReturnType<RpcService["service"]>
        >;
      },
    }));

  // ------------------------------------------------------------ EXCHANGE
  const exchangeTablesByName: Record<ExchangeTableName, Table> = {
    instruments,
    prices,
    depth,
    trades,
    bars,
    bookSamples,
    bookOrders,
    bookEvents,
    simBooks,
    bots,
    botParams,
    simSamples,
    botHistory,
    botFills,
    simEvents,
    scenarios,
    scenarioRuns,
    simSession,
    timeSeriesBuckets,
    instrumentPrices: instrumentPricesJoin,
  };
  const exchangeSchemas = forEachTable(
    EXCHANGE_TABLE_NAMES,
    (name) => exchangeTablesByName[name].schema,
  );
  const exchangeServices = rpcServices(
    [...EXCHANGE_ADMIN_RPC_NAMES, ...EXCHANGE_QUERY_RPC_NAMES],
    () => exchange,
  );
  const exchange: TradingLocalModule<ExchangeTableName> =
    new TradingLocalModule({
      name: EXCHANGE_MODULE,
      schemas: exchangeSchemas,
      tables: exchangeTablesByName,
      services: forEachTable(EXCHANGE_TABLE_NAMES, () => exchangeServices),
      visualLinks: visualLinksFor<ExchangeTableName>(
        exchangeTables,
        EXCHANGE_TABLE_NAMES,
      ),
      onCreateDataSource,
    });

  // ------------------------------------------------------------ OMS
  const omsTablesByName: Record<OmsLocalTableName, Table> = {
    ...omsTableMap,
    positionPrices: positionPricesJoin,
    orderEntryPrices: orderEntryPricesJoin,
  };
  const omsSchemas = forEachTable(
    OMS_TABLE_NAMES,
    (name) => omsTablesByName[name].schema,
  );
  const omsServices: RpcService[] = [
    ...rpcServices(OMS_RPC_NAMES, () => oms),
    ...rpcServices(CLIENT_ADMIN_RPC_NAMES, () => oms),
    ...rpcServices(ORDER_ENTRY_RPC_NAMES, () => oms),
    {
      // As OmsRpcHandler: orders are only entered with createOrder.
      rpcName: "addRow",
      service: async () => ({
        type: "ERROR_RESULT",
        errorMessage: "addRow: use createOrder to enter orders",
      }),
    },
  ];
  // Every OMS table carries an `account` column (as OmsModule on the server).
  const permission: PermissionFunction = (viewport) => {
    const access = omsService.accessFor(viewport.user);
    return access.all
      ? AllowAllPermissionFilter
      : PermissionFilter("account", new Set(access.accounts));
  };
  // Order ticket rows: each user sees only their own (as OmsModule).
  const ownRows: PermissionFunction = (viewport) =>
    PermissionFilter("user", new Set([viewport.user.name]));
  // The ticket edits its row directly through the orderEntryPrices join;
  // the edit is written to orderEntry by OrderEntryService (as
  // OmsRpcHandler's applyCellEdit on the server).
  const orderEntryServices: RpcService[] = [
    ...omsServices,
    {
      rpcName: "editCell",
      service: async (request) => {
        const user =
          request.context.type === "VIEWPORT_CONTEXT"
            ? oms.userForViewport(request.context.viewPortId)
            : getCurrentUser();
        return handleOrderEntryEditCell(
          omsService,
          request.params as { key?: unknown; column?: unknown; data?: unknown },
          user,
        ) as Awaited<ReturnType<RpcService["service"]>>;
      },
    },
  ];
  const isOrderEntryTable = (name: OmsLocalTableName) =>
    name === "orderEntry" || name === "orderEntryPrices";
  // clientBots / clientBotParams: sim admins only (as OmsModule)
  const simAdminOnly: PermissionFunction = (viewport) =>
    canAdminSim(viewport.user, omsService.permissionMode)
      ? AllowAllPermissionFilter
      : PermissionFilter(() => false);
  const oms: TradingLocalModule<OmsLocalTableName> = new TradingLocalModule({
    name: OMS_MODULE,
    schemas: omsSchemas,
    tables: omsTablesByName,
    services: forEachTable(OMS_TABLE_NAMES, (name) =>
      isOrderEntryTable(name) ? orderEntryServices : omsServices,
    ),
    visualLinks: visualLinksFor<OmsLocalTableName>(omsTables, OMS_TABLE_NAMES),
    permissionFunctions: forEachTable(OMS_TABLE_NAMES, (name) =>
      name === "clientBots" || name === "clientBotParams"
        ? simAdminOnly
        : isOrderEntryTable(name)
          ? ownRows
          : permission,
    ),
    onCreateDataSource,
    editHooks: {
      parentOrders: parentOrdersEditHooks(omsService, rpc),
    },
  });

  // ------------------------------------------------------------ METRICS
  const metricsTablesByName = forEachTable(METRICS_TABLE_NAMES, (name) =>
    tableFor(metricsModuleTables[name]),
  );
  const metricsPublisher = new MetricsTablePublisher({ processName: "local" });
  for (const name of METRICS_TABLE_NAMES)
    metricsPublisher.attach(name, metricsTablesByName[name].engineTable);
  metricsCollector.onSnapshot(metricsPublisher.publish);
  // Row counts, as vuuServerSource reports them on the server.
  metricsCollector.register({
    name: "local-tables",
    collect(w) {
      for (const [module, tables] of [
        [EXCHANGE_MODULE, exchangeTablesByName],
        [OMS_MODULE, omsTablesByName],
        [METRICS_MODULE, metricsTablesByName],
      ] as const) {
        for (const [name, table] of Object.entries(tables))
          w.tableRows(module, name, table.data.length);
      }
    },
  });
  const metricsSchemas = forEachTable(
    METRICS_TABLE_NAMES,
    (name) => metricsTablesByName[name].schema,
  );
  const metrics: TradingLocalModule<MetricsTableName> = new TradingLocalModule({
    name: METRICS_MODULE,
    schemas: metricsSchemas,
    tables: metricsTablesByName,
    services: forEachTable(METRICS_TABLE_NAMES, () => undefined),
    visualLinks: forEachTable(METRICS_TABLE_NAMES, () => undefined),
    onCreateDataSource,
  });

  const engine = createLocalEngine({ modules: [exchange, oms, metrics] });

  if (autoStart === true) start();

  const schemas = { ...exchangeSchemas, ...omsSchemas, ...metricsSchemas };

  return {
    exchange,
    oms,
    metrics,
    metricsCollector,
    engine,
    sim,
    omsService,
    schemas,
    clock,
    get running() {
      return running;
    },
    start,
    stop,
    advance(ms: number) {
      if (!clock) {
        throw Error(
          "advance(ms) requires createTradingTestData({ manualClock })",
        );
      }
      const slice = sim.config.botStepMs;
      const algoEvery = omsService.config.algoSliceMs;
      for (let elapsed = 0; elapsed < ms; ) {
        const dt = Math.min(slice, ms - elapsed);
        clock.advance(dt);
        sim.step();
        omsService.flow.step(dt);
        omsService.clients.step(dt);
        algoElapsed += dt;
        if (algoElapsed >= algoEvery) {
          algoElapsed -= algoEvery;
          omsService.engine.stepAlgos();
        }
        elapsed += dt;
      }
      sim.flush();
      omsService.mark();
      omsService.orderEntry.refresh();
      metricsCollector.sample(clock.time);
    },
    rpc,
    dispose() {
      stop();
      omsService.dispose();
      engine.dispose();
    },
  };
};
