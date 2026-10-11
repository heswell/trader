import {
  type DataTable,
  ModuleFactory,
  Provider,
  type ServiceFactory,
  type TableContainer,
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

type ProviderTable = ConstructorParameters<typeof Provider>[0];
type TableName = keyof ExchangeTables;

export interface ExchangeModuleOptions {
  /** Start the step/flush timers once tables are loaded (default true). */
  autoStart?: boolean;
}

/**
 * Collects the four EXCHANGE tables as their providers load, then hands them
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
    const { instruments, prices, depth, trades } = this.#tables;
    if (instruments && prices && depth && trades && !this.sim.publisher) {
      this.sim.attachTables({ instruments, prices, depth, trades });
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
 * The EXCHANGE Vuu module: instruments, prices, depth, trades and the
 * instrumentPrices join, all driven by `sim`. Every table (including the
 * join) carries the admin RPC service.
 */
export const ExchangeModule = (
  sim: ExchangeSimulator,
  { autoStart = true }: ExchangeModuleOptions = {},
) => {
  const binder = new TableBinder(sim, autoStart);
  const services = new WeakMap<TableContainer, ExchangeAdminRpcHandler>();
  const serviceFactory: ServiceFactory = (
    table: DataTable,
    _provider,
    _providerContainer,
    tableContainer,
  ) => {
    let service = services.get(tableContainer);
    if (!service) {
      service = new ExchangeAdminRpcHandler(tableContainer, sim);
      services.set(tableContainer, service);
    }
    return ViewPortDef(table.tableDef.columns, service);
  };

  const defs = createExchangeTableDefs();
  const provider = (name: TableName) => (table: ProviderTable) =>
    new SimTableProvider(table, name, binder);

  const module = ModuleFactory.withNameSpace(EXCHANGE_MODULE)
    .addTable(defs.instruments, provider("instruments"), serviceFactory)
    .addTable(defs.prices, provider("prices"), serviceFactory)
    .addTable(defs.depth, provider("depth"), serviceFactory)
    .addTable(defs.trades, provider("trades"), serviceFactory)
    .addJoinTable(toServerJoinFactory(instrumentPrices))
    .asModule();
  // addJoinTable takes no ServiceFactory; viewPortDefs is the live map that
  // VuuServer.registerModule reads, so register the join's service here.
  // See docs/upstream-issues.md.
  module.viewPortDefs.set(instrumentPrices.name, serviceFactory);
  return module;
};
