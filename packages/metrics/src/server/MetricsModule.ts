import {
  ModuleFactory,
  PermissionFilter,
  type PermissionFunction,
  Provider,
} from "@heswell/vuu-server";
import { METRICS_MODULE } from "@heswell/trading-schemas";
import { createMetricsTableDefs } from "@heswell/trading-schemas/server";
import type { MetricsCollector } from "../MetricsCollector";
import {
  type MetricsTable,
  type MetricsTableName,
  MetricsTablePublisher,
} from "./MetricsTablePublisher";

type ProviderTable = ConstructorParameters<typeof Provider>[0];

const TABLES: readonly MetricsTableName[] = [
  "metricsProcess",
  "metrics",
  "metricsTables",
  "metricsHistory",
];

/** The viewport user, as vuu-server passes it to permission functions. */
export interface MetricsUser {
  name?: string;
  authorizations?: readonly string[];
}

export interface MetricsModuleOptions {
  /** Start the collector once the tables are loaded (default true). */
  autoStart?: boolean;
  /** Who sees rows; everyone when omitted. */
  canView?: (user: MetricsUser | undefined) => boolean;
  /** Key of the metricsProcess row (default "trading"). */
  processName?: string;
  /** metricsHistory rows kept per metric (default 300; 0 = no history). */
  historySize?: number;
}

class MetricsTableProvider extends Provider {
  constructor(
    table: ProviderTable,
    private readonly name: MetricsTableName,
    private readonly onLoad: (
      name: MetricsTableName,
      table: MetricsTable,
    ) => void,
    private readonly onStop: () => void,
  ) {
    super(table);
  }

  async load() {
    this.onLoad(this.name, this.table as unknown as MetricsTable);
  }

  doStop() {
    this.onStop();
  }
}

/**
 * The METRICS Vuu module: metricsProcess, metrics, metricsTables and
 * metricsHistory, written from `collector` snapshots once per interval. The
 * collector starts when all four tables have loaded.
 */
export const MetricsModule = (
  collector: MetricsCollector,
  {
    autoStart = true,
    canView,
    processName,
    historySize,
  }: MetricsModuleOptions = {},
) => {
  const publisher = new MetricsTablePublisher({ processName, historySize });
  let stopped = false;
  let unsubscribe: (() => void) | undefined;
  const onLoad = (name: MetricsTableName, table: MetricsTable) => {
    publisher.attach(name, table);
    if (!TABLES.every((t) => publisher.attached.includes(t))) return;
    unsubscribe ??= collector.onSnapshot(publisher.publish);
    if (autoStart && !stopped) collector.start();
  };
  const onStop = () => {
    stopped = true;
    unsubscribe?.();
    unsubscribe = undefined;
    collector.stop();
  };

  const permissionFunction: PermissionFunction | undefined = canView
    ? (viewport) => {
        const allowed = canView(viewport.user as MetricsUser);
        return PermissionFilter(() => allowed);
      }
    : undefined;
  const defs = createMetricsTableDefs();
  let factory = ModuleFactory.withNameSpace(METRICS_MODULE);
  for (const name of TABLES) {
    if (permissionFunction) defs[name].permissionFunction = permissionFunction;
    factory = factory.addTable(
      defs[name],
      (table: ProviderTable) =>
        new MetricsTableProvider(table, name, onLoad, onStop),
    );
  }
  return factory.asModule();
};
