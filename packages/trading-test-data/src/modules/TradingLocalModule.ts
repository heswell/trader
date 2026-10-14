import {
  type EditHooks,
  getCurrentUser,
  type PermissionFunction,
  type RpcService,
  type ServiceHandler,
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
  /**
   * Per-table edit hooks. Without them a table is read-only (as on the
   * server): no direct source edits and no editable session columns.
   */
  editHooks?: Partial<Record<T, EditHooks>>;
}

/**
 * A config-driven engine-local VuuModule. Register it with a LocalEngine
 * (createTradingTestData does).
 */
export class TradingLocalModule<T extends string> extends VuuModule<T> {
  protected menus = undefined;
  protected menuServices = undefined;
  protected schemas: Record<T, TableSchema>;
  protected tables: Record<T, Table>;
  protected services: Record<T, RpcService[] | undefined>;
  protected visualLinks: Record<T, VuuLink[] | undefined>;
  protected editHooks: Partial<Record<T, EditHooks>>;
  protected moduleServices: RpcService[] = [
    {
      rpcName: "deleteRow",
      service: (request) => this.markRowDeleted(request),
    },
  ];
  #config: TradingLocalModuleConfig<T>;

  constructor(config: TradingLocalModuleConfig<T>) {
    super(config.name);
    this.#config = config;
    this.schemas = config.schemas;
    this.tables = config.tables;
    this.services = config.services;
    this.visualLinks = config.visualLinks;
    this.permissionFunctions = config.permissionFunctions;
    this.editHooks = config.editHooks ?? {};
  }

  protected beforeCreateDataSource(tableName: T) {
    this.#config.onCreateDataSource?.(tableName);
  }

  protected canEditSource() {
    return false;
  }

  protected isEditableColumn() {
    return false;
  }

  /**
   * deleteRow as vuu-server: only in an edit session, where the row is
   * marked (vuuAction "deleteRow") for endEditSession, whatever the `mode`.
   * engine-local's built-in removes the row from the session on a "hard"
   * delete (vuu-ui's default), so the save never sees it, and outside a
   * session deletes the source row (upstream issue 76).
   */
  private markRowDeleted: ServiceHandler = async (request) => {
    const { context, params } = request;
    const key = String((params as { key?: unknown }).key);
    const sessionTable =
      context.type === "VIEWPORT_CONTEXT"
        ? this.getSessionTable(context.viewPortId, false)
        : undefined;
    if (!sessionTable) {
      return {
        type: "ERROR_RESULT",
        errorMessage: "deleteRow: only supported in an edit session",
      };
    }
    if (!sessionTable.findByKey(key)) {
      return {
        type: "ERROR_RESULT",
        errorMessage: `deleteRow: row ${key} not found`,
      };
    }
    sessionTable.update(key, "vuuAction", "deleteRow");
    return { type: "SUCCESS_RESULT", data: undefined };
  };

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
