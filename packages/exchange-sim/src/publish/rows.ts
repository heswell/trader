import type { TableDefinition } from "@heswell/trading-schemas";

/** null = no value (no quote / no trade yet), rendered empty by the UI. */
export type RowValue = string | number | boolean | null;

/** Structural subset of a vuu-table Table used for publishing. */
export interface PublishTable {
  readonly columnMap: Record<string, number>;
  readonly columns: readonly unknown[];
  insert(row: RowValue[]): unknown;
  update(rowIdx: number, row: RowValue[]): unknown;
  delete(key: string): boolean;
  rowIndexAtKey(key: string): number;
}

export const round = (value: number, decimals: number) => {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
};

export class RowLayout<T extends TableDefinition> {
  readonly #template: RowValue[];
  readonly idx: Record<T["columns"][number]["name"], number>;

  /**
   * numeric: the value for numeric columns not set by the caller. Prices use
   * null (no quote or trade yet), so a LEFT JOIN or a pre-loaded row never
   * shows a fake 0 (trader upstream issue 33).
   */
  constructor(table: PublishTable, def: T, numeric: 0 | null = 0) {
    const template: RowValue[] = new Array(table.columns.length).fill(numeric);
    const idx = {} as Record<string, number>;
    for (const { name, dataType } of def.columns) {
      const i = table.columnMap[name];
      if (i === undefined) throw Error(`${def.name}: no column ${name}`);
      idx[name] = i;
      template[i] =
        dataType === "string" ? "" : dataType === "boolean" ? false : numeric;
    }
    this.#template = template;
    this.idx = idx;
  }

  row() {
    return this.#template.slice();
  }
}
