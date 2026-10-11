import type { VuuColumnDataType } from "@vuu-ui/vuu-protocol-types";

/** Column data types used by trading tables (subset of VuuColumnDataType). */
export type TradingColumnDataType = Extract<
  VuuColumnDataType,
  "string" | "int" | "long" | "double" | "boolean" | "epochtimestamp"
>;

export interface ColumnDefinition {
  readonly name: string;
  readonly dataType: TradingColumnDataType;
  /** Column may be left at its default (0 / "") by providers that don't support it. */
  readonly optional?: boolean;
  readonly description?: string;
}

export interface LinkDefinition {
  /** Column in this (child) table. */
  readonly fromColumn: string;
  /** Parent table name. */
  readonly toTable: string;
  readonly toColumn: string;
}

export interface TableDefinition<
  C extends readonly ColumnDefinition[] = readonly ColumnDefinition[],
> {
  readonly module: string;
  readonly name: string;
  readonly keyField: C[number]["name"];
  readonly columns: C;
  readonly joinFields?: readonly C[number]["name"][];
  /** Visual links (child -> parent) offered to the UI. */
  readonly links?: readonly LinkDefinition[];
  readonly description?: string;
}

export type JoinType = "LeftOuterJoin" | "InnerJoin";

export interface JoinDefinition {
  /** Module the join table is registered in. */
  readonly module: string;
  readonly name: string;
  readonly baseTable: TableDefinition;
  readonly joinTable: TableDefinition;
  /** Column on base table. */
  readonly left: string;
  /** Column on join table. */
  readonly right: string;
  readonly type: JoinType;
  /** Join-table columns to include (all non-colliding columns if omitted). */
  readonly joinColumns?: readonly string[];
  readonly description?: string;
}

type TsTypeOf<D extends TradingColumnDataType> = D extends "string"
  ? string
  : D extends "boolean"
    ? boolean
    : number;

/** Object row type derived from a table definition. */
export type RowOf<T extends TableDefinition> = {
  -readonly [C in T["columns"][number] as C["name"]]: TsTypeOf<C["dataType"]>;
};

export type ColumnName<T extends TableDefinition> =
  T["columns"][number]["name"];

/** Positional row, in column order (the shape Vuu tables store). */
export type RowArray = (string | number | boolean)[];

export const defineTable = <const C extends readonly ColumnDefinition[]>(
  def: TableDefinition<C>,
): TableDefinition<C> => {
  const names = new Set<string>();
  for (const { name } of def.columns) {
    if (names.has(name)) {
      throw Error(`[trading-schemas] ${def.name}: duplicate column ${name}`);
    }
    names.add(name);
  }
  const check = (col: string, what: string) => {
    if (!names.has(col)) {
      throw Error(`[trading-schemas] ${def.name}: ${what} ${col} not a column`);
    }
  };
  check(def.keyField, "keyField");
  for (const f of def.joinFields ?? []) check(f, "joinField");
  for (const l of def.links ?? []) check(l.fromColumn, "link column");
  return Object.freeze(def);
};

export const defineJoin = (def: JoinDefinition): JoinDefinition => {
  const has = (t: TableDefinition, c: string) =>
    t.columns.some(({ name }) => name === c);
  if (!has(def.baseTable, def.left)) {
    throw Error(`[trading-schemas] ${def.name}: ${def.left} not in base table`);
  }
  if (!has(def.joinTable, def.right)) {
    throw Error(
      `[trading-schemas] ${def.name}: ${def.right} not in join table`,
    );
  }
  def.joinColumns?.forEach((c) => {
    if (!has(def.joinTable, c)) {
      throw Error(`[trading-schemas] ${def.name}: ${c} not in join table`);
    }
  });
  return Object.freeze(def);
};

/**
 * Columns of a join table: all base-table columns, then the selected
 * join-table columns that don't collide with a base column name.
 */
export const joinTableColumns = (
  join: JoinDefinition,
): readonly ColumnDefinition[] => {
  const baseNames = new Set(join.baseTable.columns.map(({ name }) => name));
  const wanted = join.joinColumns ? new Set(join.joinColumns) : undefined;
  return [
    ...join.baseTable.columns,
    ...join.joinTable.columns.filter(
      ({ name }) => !baseNames.has(name) && (!wanted || wanted.has(name)),
    ),
  ];
};

export const columnNames = <T extends TableDefinition>(def: T) =>
  def.columns.map(({ name }) => name) as ColumnName<T>[];

export const columnIndices = <T extends TableDefinition>(def: T) =>
  Object.fromEntries(def.columns.map(({ name }, i) => [name, i])) as Record<
    ColumnName<T>,
    number
  >;

const defaultValue = (dataType: TradingColumnDataType) =>
  dataType === "string" ? "" : dataType === "boolean" ? false : 0;

/**
 * Object row -> positional row. Missing columns are filled with type defaults
 * (0, "", false), so providers can omit optional columns.
 */
export const toRowArray = <T extends TableDefinition>(
  def: T,
  row: Partial<RowOf<T>>,
): RowArray =>
  def.columns.map(({ name, dataType }) => {
    const value = (row as Record<string, string | number | boolean>)[name];
    return value === undefined || value === null
      ? defaultValue(dataType)
      : value;
  });

export const fromRowArray = <T extends TableDefinition>(
  def: T,
  row: readonly unknown[],
): RowOf<T> =>
  Object.fromEntries(
    def.columns.map(({ name }, i) => [name, row[i]]),
  ) as RowOf<T>;
