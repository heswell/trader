import {
  type ExchangeAdminRpcName,
  type ExchangeSimConfig,
  ExchangeSimulator,
  handleExchangeAdminRpc,
  ManualClock,
  systemClock,
} from "@heswell/exchange-sim/engine";
import {
  handleOmsRpc,
  type OmsConfig,
  type OmsRpcName,
  OmsService,
  type OmsTableName,
  type TradingUser,
} from "@heswell/oms/engine";
import {
  EXCHANGE_ADMIN_RPC_NAMES,
  EXCHANGE_MODULE,
  exchangeTables,
  instrumentPrices,
  OMS_MODULE,
  OMS_RPC_NAMES,
  omsTables,
  type JoinDefinition,
  positionPrices,
  type RpcName,
  type TableDefinition,
  toTableSchema,
} from "@heswell/trading-schemas";
import {
  AllowAllPermissionFilter,
  createLocalEngine,
  getCurrentUser,
  type LocalEngine,
  PermissionFilter,
  type PermissionFunction,
  type RpcService,
  Table,
} from "@heswell/vuu-data-engine-local";
import { JoinTable } from "@heswell/vuu-table";
import type { TableSchema } from "@vuu-ui/vuu-data-types";
import type { RpcResult } from "@vuu-ui/vuu-protocol-types";
import { parentOrdersEditHooks } from "./modules/parentOrdersEditHooks";
import { TradingLocalModule } from "./modules/TradingLocalModule";
import { visualLinksFor } from "./modules/visualLinks";

export type ExchangeTableName =
  | keyof typeof exchangeTables
  | "instrumentPrices";
export type OmsLocalTableName = OmsTableName | "positionPrices";
export type TradingLocalTableName = ExchangeTableName | OmsLocalTableName;

export const EXCHANGE_TABLE_NAMES: readonly ExchangeTableName[] = [
  "instruments",
  "prices",
  "depth",
  "trades",
  "instrumentPrices",
];
export const OMS_TABLE_NAMES: readonly OmsLocalTableName[] = [
  "accounts",
  "parentOrders",
  "childOrders",
  "fills",
  "positions",
  "positionPrices",
];

/**
 * Browser defaults: lighter than the server (50 instruments) so the showcase
 * stays responsive; everything else is the server default.
 */
export const LOCAL_EXCHANGE_DEFAULTS: Partial<ExchangeSimConfig> = {
  activeInstruments: 50,
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
  /** The isolated engine both modules are registered with. */
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
   * publishes and marks positions.
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

const joinTableFor = (def: JoinDefinition, base: Table, join: Table) => {
  const engineTable = new JoinTable({
    schema: toTableSchema(def),
    baseTable: base.engineTable,
    joinTable: join.engineTable,
    leftColumn: def.left,
    rightColumn: def.right,
    joinType: def.type === "InnerJoin" ? "inner" : "leftOuter",
  });
  return { table: new Table(engineTable), engineTable };
};

const isExchangeRpc = (name: string): name is ExchangeAdminRpcName =>
  (EXCHANGE_ADMIN_RPC_NAMES as readonly string[]).includes(name);
const isOmsRpc = (name: string): name is OmsRpcName =>
  (OMS_RPC_NAMES as readonly string[]).includes(name);

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

  // ------------------------------------------------------------ tables
  const instruments = tableFor(exchangeTables.instruments);
  const prices = tableFor(exchangeTables.prices);
  const depth = tableFor(exchangeTables.depth);
  const trades = tableFor(exchangeTables.trades);
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

  sim.attachTables({
    instruments: instruments.engineTable,
    prices: prices.engineTable,
    depth: depth.engineTable,
    trades: trades.engineTable,
  });
  for (const name of Object.keys(omsTableMap) as OmsTableName[]) {
    omsService.tables.attach(name, omsTableMap[name].engineTable);
  }

  // ------------------------------------------------------------ lifecycle
  let running = false;
  const start = () => {
    if (running || clock) return;
    running = true;
    sim.start();
    omsService.start();
  };
  const stop = () => {
    running = false;
    sim.stop();
    omsService.stop();
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
    if (isExchangeRpc(rpcName))
      return handleExchangeAdminRpc(sim, rpcName, params);
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
    instrumentPrices: instrumentPricesJoin.table,
  };
  const exchangeSchemas = forEachTable(
    EXCHANGE_TABLE_NAMES,
    (name) => exchangeTablesByName[name].schema,
  );
  const exchangeServices = rpcServices(
    EXCHANGE_ADMIN_RPC_NAMES,
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
    positionPrices: positionPricesJoin.table,
  };
  const omsSchemas = forEachTable(
    OMS_TABLE_NAMES,
    (name) => omsTablesByName[name].schema,
  );
  const omsServices: RpcService[] = [
    ...rpcServices(OMS_RPC_NAMES, () => oms),
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
  const oms: TradingLocalModule<OmsLocalTableName> = new TradingLocalModule({
    name: OMS_MODULE,
    schemas: omsSchemas,
    tables: omsTablesByName,
    services: forEachTable(OMS_TABLE_NAMES, () => omsServices),
    visualLinks: visualLinksFor<OmsLocalTableName>(omsTables, OMS_TABLE_NAMES),
    permissionFunctions: forEachTable(OMS_TABLE_NAMES, () => permission),
    onCreateDataSource,
    editHooks: {
      parentOrders: parentOrdersEditHooks(omsService, rpc),
    },
  });

  const engine = createLocalEngine({ modules: [exchange, oms] });

  if (autoStart === true) start();

  const schemas = { ...exchangeSchemas, ...omsSchemas };

  return {
    exchange,
    oms,
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
      for (let elapsed = 0; elapsed < ms; ) {
        const dt = Math.min(slice, ms - elapsed);
        clock.advance(dt);
        sim.step();
        omsService.flow.step(dt);
        elapsed += dt;
      }
      sim.flush();
      omsService.engine.markToMarket();
    },
    rpc,
    dispose() {
      stop();
      omsService.dispose();
      engine.dispose();
      instrumentPricesJoin.engineTable.destroy();
      positionPricesJoin.engineTable.destroy();
    },
  };
};
