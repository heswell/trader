import {
  getCurrentUser,
  type PermissionFunction,
  type RpcService,
  type Table,
  VuuModule,
  type VuuModuleUser,
} from "@heswell/vuu-data-engine-local";
import type { TableSchema } from "@vuu-ui/vuu-data-types";
import type { VuuLink } from "@vuu-ui/vuu-protocol-types";

export interface TradingLocalModuleConfig<T extends string> {
  name: string;
  schemas: Record<T, TableSchema>;
  tables: Record<T, Table>;
  services: Record<T, RpcService[] | undefined>;
  visualLinks: Record<T, VuuLink[] | undefined>;
  permissionFunctions?: Partial<Record<T, PermissionFunction>>;
  /** Called before every data source is created (used to lazily start the sim). */
  onCreateDataSource?: (tableName: T) => void;
  /** Replaces the default edit-session save for a source table. */
  beforeSessionSave?: (sourceTable: Table, sessionTable: Table) => void;
}

/**
 * A config-driven engine-local VuuModule. Construction registers the module
 * (by name) in engine-local's global module container, replacing any
 * previous module of the same name.
 */
export class TradingLocalModule<T extends string> extends VuuModule<T> {
  protected menus = undefined;
  protected menuServices = undefined;
  protected schemas: Record<T, TableSchema>;
  protected tables: Record<T, Table>;
  protected services: Record<T, RpcService[] | undefined>;
  protected visualLinks: Record<T, VuuLink[] | undefined>;
  #config: TradingLocalModuleConfig<T>;

  constructor(config: TradingLocalModuleConfig<T>) {
    super(config.name);
    this.#config = config;
    this.schemas = config.schemas;
    this.tables = config.tables;
    this.services = config.services;
    this.visualLinks = config.visualLinks;
    this.permissionFunctions = config.permissionFunctions;
  }

  protected beforeCreateDataSource(tableName: T) {
    this.#config.onCreateDataSource?.(tableName);
  }

  protected async beforeSessionSave(sourceTable: Table, sessionTable: Table) {
    this.#config.beforeSessionSave?.(sourceTable, sessionTable);
  }

  /** Table by name (the engine-local wrapper; `.engineTable` for raw access). */
  getTable(tableName: T): Table {
    return this.tables[tableName];
  }

  /** The user that owns a viewport (falls back to the current user). */
  userForViewport(viewportId: string): VuuModuleUser {
    try {
      return this.getSubscriptionByViewport(viewportId).user;
    } catch {
      return getCurrentUser();
    }
  }
}
