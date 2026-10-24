import {
  type DataTable,
  NotificationModule,
  Provider,
  type ServiceFactory,
  ViewPortDef,
} from "@heswell/vuu-server";
import type { OmsService } from "../../engine/OmsService";
import {
  type OmsNotification,
  OmsNotifier,
  type OmsNotifierOptions,
} from "../../notifications/OmsNotifier";
import { omsPermissionFunction } from "../oms/OmsModule";

type ProviderTable = ConstructorParameters<typeof Provider>[0];
type RowValue = string | number | boolean;

/** Columns added to the generic notification columns. */
export const OMS_NOTIFICATION_COLUMNS = [
  "account:String",
  "ric:String",
  "orderId:String",
];

export interface OmsNotificationModuleOptions
  extends Pick<
    OmsNotifierOptions,
    "rejectTtlMs" | "riskTtlMs" | "warnAt" | "clock"
  > {
  /** How often expired rows are deleted (default 15s). */
  sweepIntervalMs?: number;
}

/** Writes notifications to the table and deletes them once expired. */
export class OmsNotificationProvider extends Provider {
  #stopObserving?: () => void;
  #sweep?: ReturnType<typeof setInterval>;

  constructor(
    table: ProviderTable,
    private readonly oms: OmsService,
    private readonly options: OmsNotificationModuleOptions = {},
  ) {
    super(table);
  }

  get #table() {
    return this.table as unknown as DataTable;
  }

  async load() {
    const { sweepIntervalMs = 15_000, ...notifierOptions } = this.options;
    const { engine } = this.oms;
    const notifier = new OmsNotifier({
      ...notifierOptions,
      accounts: (account) => engine.accounts.get(account),
      publish: (notification) => this.publish(notification),
    });
    this.#stopObserving = engine.observe(notifier);
    this.#sweep = setInterval(() => this.sweep(), sweepIntervalMs);
  }

  publish(notification: OmsNotification) {
    const table = this.#table;
    const { columnMap } = table;
    const now = this.options.clock?.() ?? Date.now();
    const row: RowValue[] = new Array(table.schema.columns.length).fill("");
    const values: Record<string, RowValue> = {
      ...notification,
      vuuCreatedTimestamp: now,
      vuuUpdatedTimestamp: now,
    };
    for (const [name, value] of Object.entries(values)) {
      const index = columnMap[name];
      if (index !== undefined) row[index] = value;
    }
    table.upsert(row);
  }

  /** Delete rows whose expiryTime has passed. */
  sweep(now = this.options.clock?.() ?? Date.now()) {
    const table = this.#table;
    const { expiryTime, id } = table.columnMap;
    const expired = table.rows
      .filter((row) => Number(row[expiryTime]) <= now)
      .map((row) => String(row[id]));
    for (const key of expired) table.delete(key);
    return expired.length;
  }

  doStop() {
    this.#stopObserving?.();
    if (this.#sweep) clearInterval(this.#sweep);
  }
}

/**
 * The trading server's NOTIFICATIONS module: vuu-server's generic
 * `notifications` table (with a `topic` column), plus account / ric /
 * orderId, fed by OmsNotifier. Rows are visible to users who may see the
 * account, as for the OMS tables. The portal routes each row to the nav
 * entries whose `notificationTopics` include its topic.
 */
export const OmsNotificationModule = (
  oms: OmsService,
  options: OmsNotificationModuleOptions = {},
) => {
  const serviceFactory: ServiceFactory = (table: DataTable) =>
    ViewPortDef.default(table.tableDef.columns);
  return NotificationModule(
    (table: ProviderTable) => new OmsNotificationProvider(table, oms, options),
    omsPermissionFunction(oms),
    serviceFactory,
    ...OMS_NOTIFICATION_COLUMNS,
  );
};
