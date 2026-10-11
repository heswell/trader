import {
  accounts,
  childOrders,
  fills,
  omsTables,
  parentOrders,
  positions,
  type TableDefinition,
  toRowArray,
} from "@heswell/trading-schemas";
import type { OmsSink } from "../../engine/OmsEngine";

type RowValue = string | number | boolean;

/** Structural subset of a vuu-server DataTable used by the OMS. */
export interface OmsTable {
  readonly columnMap: Record<string, number>;
  readonly columns: readonly unknown[];
  insert(row: RowValue[]): unknown;
  updateByKey(key: string, values: Record<string, RowValue>): unknown;
  rowIndexAtKey(key: string): number;
}

export type OmsTableName = keyof typeof omsTables;

/**
 * OmsSink writing to the Vuu tables. Rows emitted before a table's provider
 * has loaded are buffered (latest per key) and written on attach.
 */
export class TableSink implements OmsSink {
  #tables: Partial<Record<OmsTableName, OmsTable>> = {};
  #pending = new Map<OmsTableName, Map<string, Record<string, unknown>>>();

  attach(name: OmsTableName, table: OmsTable) {
    this.#tables[name] = table;
    const pending = this.#pending.get(name);
    this.#pending.delete(name);
    if (pending) for (const row of pending.values()) this.#write(name, row);
  }

  get attached() {
    return Object.keys(this.#tables) as OmsTableName[];
  }

  #write(name: OmsTableName, values: Record<string, unknown>) {
    const def: TableDefinition = omsTables[name];
    const key = String(values[def.keyField]);
    const table = this.#tables[name];
    if (!table) {
      let pending = this.#pending.get(name);
      if (!pending) {
        pending = new Map();
        this.#pending.set(name, pending);
      }
      pending.set(key, values);
      return;
    }
    if (table.rowIndexAtKey(key) === -1) {
      const ordered = toRowArray(def, values as never);
      const row: RowValue[] = new Array(table.columns.length).fill(0);
      def.columns.forEach(({ name: column }, i) => {
        row[table.columnMap[column]] = ordered[i];
      });
      table.insert(row);
    } else {
      table.updateByKey(key, values as Record<string, RowValue>);
    }
  }

  account = (row: object) =>
    this.#write(accounts.name as OmsTableName, { ...row });
  parentOrder = (row: Record<string, unknown>) =>
    this.#write(parentOrders.name as OmsTableName, row);
  childOrder = (row: Record<string, unknown>) =>
    this.#write(childOrders.name as OmsTableName, row);
  fill = (row: object) => this.#write(fills.name as OmsTableName, { ...row });
  position = (row: object) =>
    this.#write(positions.name as OmsTableName, { ...row });
}
