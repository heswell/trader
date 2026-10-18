import {
  type DataTable,
  ModuleFactory,
  type PermissionFunction,
  PermissionFilter,
  Provider,
  type ServiceFactory,
  ViewPortDef,
} from "@heswell/vuu-server";
import { OMS_MODULE, positionPrices } from "@heswell/trading-schemas";
import {
  createOmsTableDefs,
  toServerJoinFactory,
} from "@heswell/trading-schemas/server";
import type { OmsService } from "../../engine/OmsService";
import { OmsRpcHandler } from "./OmsRpcHandler";
import type { OmsTable, OmsTableName } from "./TableSink";

type ProviderTable = ConstructorParameters<typeof Provider>[0];

export interface OmsModuleOptions {
  /** Start the background flow / mark timers once all tables are loaded (default true). */
  autoStart?: boolean;
  /**
   * Register the positionPrices join (positions x EXCHANGE prices). Requires
   * the EXCHANGE module in the same server, registered first. Default true.
   */
  positionPrices?: boolean;
}

const TABLES: readonly OmsTableName[] = [
  "accounts",
  "parentOrders",
  "childOrders",
  "fills",
  "positions",
  "pnlHistory",
  "accountPnlHistory",
];

class OmsTableProvider extends Provider {
  constructor(
    table: ProviderTable,
    private readonly name: OmsTableName,
    private readonly onLoad: (name: OmsTableName, table: OmsTable) => void,
    private readonly onStop: () => void,
  ) {
    super(table);
  }

  async load() {
    this.onLoad(this.name, this.table as unknown as OmsTable);
  }

  doStop() {
    this.onStop();
  }
}

/**
 * Every OMS table carries an `account` column; rows are visible when the
 * viewport user may see the account (see permissions/access.ts).
 */
export const omsPermissionFunction =
  (oms: OmsService): PermissionFunction =>
  (viewport) => {
    const access = oms.accessFor(viewport.user);
    if (access.all) return PermissionFilter(() => true);
    return PermissionFilter("account", new Set(access.accounts));
  };

/**
 * The OMS Vuu module: accounts, parentOrders, childOrders, fills, positions,
 * pnlHistory, accountPnlHistory and the positionPrices join, written by `oms`. Every table (and the join)
 * carries the OMS RPC service, so order RPCs work from any OMS viewport.
 */
export const OmsModule = (
  oms: OmsService,
  { autoStart = true, positionPrices: withJoin = true }: OmsModuleOptions = {},
) => {
  let stopped = false;
  const onLoad = (name: OmsTableName, table: OmsTable) => {
    oms.tables.attach(name, table);
    if (
      autoStart &&
      !stopped &&
      TABLES.every((t) => oms.tables.attached.includes(t))
    ) {
      oms.start();
    }
  };
  const onStop = () => {
    stopped = true;
    oms.stop();
  };

  // Called once per viewport (CREATE_VP), including viewports on edit-session
  // tables. OmsRpcHandler keeps no cross-viewport state: orders and
  // permissions live in `oms`, session tables in the TableContainer.
  const serviceFactory: ServiceFactory = (
    table: DataTable,
    _provider,
    _providerContainer,
    tableContainer,
  ) =>
    ViewPortDef(table.tableDef.columns, new OmsRpcHandler(tableContainer, oms));

  const permissionFunction = omsPermissionFunction(oms);
  const defs = createOmsTableDefs();
  const provider = (name: OmsTableName) => (table: ProviderTable) =>
    new OmsTableProvider(table, name, onLoad, onStop);

  let factory = ModuleFactory.withNameSpace(OMS_MODULE);
  for (const name of TABLES) {
    defs[name].permissionFunction = permissionFunction;
    factory = factory.addTable(defs[name], provider(name), serviceFactory);
  }
  if (withJoin) {
    factory = factory.addJoinTable(
      toServerJoinFactory(positionPrices, { permissionFunction }),
      serviceFactory,
    );
  }
  return factory.asModule();
};
