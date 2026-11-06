import {
  type DataTable,
  ModuleFactory,
  PermissionFilter,
  type PermissionFunction,
  Provider,
  type ServiceFactory,
  ViewPortDef,
} from "@heswell/vuu-server";
import { EXCHANGE_MODULE, instrumentPrices } from "@heswell/trading-schemas";
import {
  createExchangeTableDefs,
  toServerJoinFactory,
} from "@heswell/trading-schemas/server";
import type { ExchangeSimulator } from "../../engine/ExchangeSimulator";
import type {
  ExchangeTables,
  PublishTable,
} from "../../publish/MarketDataPublisher";
import { ExchangeAdminRpcHandler } from "./ExchangeAdminService";
import {
  canAdminSim,
  type SimPermissionMode,
  type SimUser,
} from "./simAdminAccess";

type ProviderTable = ConstructorParameters<typeof Provider>[0];
type TableName = keyof ExchangeTables;
const TABLE_NAMES: readonly TableName[] = [
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
];

/** Tables only sim-admin users see rows of (see simAdminAccess.ts). */
const SIM_ADMIN_TABLES = [
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
] as const;

/** Sim-admin tables: every row for sim admins, none for anyone else. */
export const simAdminPermissionFunction =
  (mode: SimPermissionMode): PermissionFunction =>
  (viewport) => {
    const allowed = canAdminSim(viewport.user as SimUser, mode);
    return PermissionFilter(() => allowed);
  };

export interface ExchangeModuleOptions {
  /** Start the step/flush timers once tables are loaded (default true). */
  autoStart?: boolean;
}

/**
 * Collects the EXCHANGE tables as their providers load, then hands them
 * to the simulator (static rows + initial snapshot) and starts it.
 */
class TableBinder {
  readonly #tables: Partial<ExchangeTables> = {};
  #stopped = false;

  constructor(
    readonly sim: ExchangeSimulator,
    readonly autoStart: boolean,
  ) {}

  bind(name: TableName, table: PublishTable) {
    this.#tables[name] = table;
    const tables = this.#tables;
    if (
      TABLE_NAMES.every((tableName) => tables[tableName]) &&
      !this.sim.publisher
    ) {
      this.sim.attachTables(tables as ExchangeTables);
      if (this.autoStart && !this.#stopped) this.sim.start();
    }
  }

  stop() {
    this.#stopped = true;
    this.sim.stop();
  }
}

class SimTableProvider extends Provider {
  constructor(
    table: ProviderTable,
    private readonly name: TableName,
    private readonly binder: TableBinder,
  ) {
    super(table);
  }

  async load() {
    this.binder.bind(this.name, this.table as unknown as PublishTable);
  }

  doStop() {
    this.binder.stop();
  }
}

/**
 * The EXCHANGE Vuu module: instruments, prices, depth, trades, bars,
 * bookSamples, bookOrders, bookEvents, the sim-admin tables (simBooks, bots,
 * botParams, simSamples, botHistory, botFills; rows only for sim-admin users) and the instrumentPrices join,
 * all driven by `sim`. Every table (including the join) carries the admin
 * RPC service, which also requires sim-admin.
 */
export const ExchangeModule = (
  sim: ExchangeSimulator,
  { autoStart = true }: ExchangeModuleOptions = {},
) => {
  const binder = new TableBinder(sim, autoStart);
  // Called once per viewport (CREATE_VP). The handler holds no state of its
  // own (the simulator does), so each viewport gets a fresh one.
  const serviceFactory: ServiceFactory = (
    table: DataTable,
    _provider,
    _providerContainer,
    tableContainer,
  ) =>
    ViewPortDef(
      table.tableDef.columns,
      new ExchangeAdminRpcHandler(tableContainer, sim),
    );

  const defs = createExchangeTableDefs();
  const adminOnly = simAdminPermissionFunction(
    sim.config.permissionMode as SimPermissionMode,
  );
  for (const name of SIM_ADMIN_TABLES)
    defs[name].permissionFunction = adminOnly;
  const provider = (name: TableName) => (table: ProviderTable) =>
    new SimTableProvider(table, name, binder);

  return ModuleFactory.withNameSpace(EXCHANGE_MODULE)
    .addTable(defs.instruments, provider("instruments"), serviceFactory)
    .addTable(defs.prices, provider("prices"), serviceFactory)
    .addTable(defs.depth, provider("depth"), serviceFactory)
    .addTable(defs.trades, provider("trades"), serviceFactory)
    .addTable(defs.bars, provider("bars"), serviceFactory)
    .addTable(defs.bookSamples, provider("bookSamples"), serviceFactory)
    .addTable(defs.bookOrders, provider("bookOrders"), serviceFactory)
    .addTable(defs.bookEvents, provider("bookEvents"), serviceFactory)
    .addTable(defs.simBooks, provider("simBooks"), serviceFactory)
    .addTable(defs.bots, provider("bots"), serviceFactory)
    .addTable(defs.botParams, provider("botParams"), serviceFactory)
    .addTable(defs.simSamples, provider("simSamples"), serviceFactory)
    .addTable(defs.botHistory, provider("botHistory"), serviceFactory)
    .addTable(defs.botFills, provider("botFills"), serviceFactory)
    .addTable(defs.simEvents, provider("simEvents"), serviceFactory)
    .addTable(defs.scenarios, provider("scenarios"), serviceFactory)
    .addTable(defs.scenarioRuns, provider("scenarioRuns"), serviceFactory)
    .addTable(defs.simSession, provider("simSession"), serviceFactory)
    .addJoinTable(toServerJoinFactory(instrumentPrices), serviceFactory)
    .asModule();
};
