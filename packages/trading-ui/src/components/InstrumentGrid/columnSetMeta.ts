import type { Filter } from "@vuu-ui/vuu-filter-types";
import type {
  ColumnSetsChangeReason,
  ColumnSetsState,
} from "@vuu-ui/vuu-table-extras";
import type { ColumnDescriptor } from "@vuu-ui/vuu-table-types";

/**
 * What the grid keeps per column set beside vuu's ColumnSetsState (whose
 * saveAs drops extra fields): the quick filter fields the set shows.
 */
export interface ColumnSetMeta {
  quickFilterColumns?: string[];
  /**
   * The one scope (ALL_INSTRUMENTS or a watchlist id) the set is in;
   * undefined = shared by every scope.
   */
  scope?: string;
}

/** Meta by column set name. */
export type ColumnSetMetaState = Record<string, ColumnSetMeta>;

export const COLUMN_SET_META_SETTINGS_KEY =
  "trading.instrumentGrid.columnSetMeta";

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((v) => typeof v === "string");

/** Defensive parse: persisted settings can come from any version / host. */
export const parseColumnSetMeta = (
  json: string | null | undefined,
): ColumnSetMetaState | undefined => {
  if (!json) return undefined;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return undefined;
    const meta: ColumnSetMetaState = {};
    for (const [name, value] of Object.entries(parsed)) {
      const { quickFilterColumns: columns, scope } =
        (value as ColumnSetMeta | null) ?? {};
      meta[name] = {
        ...(isStringArray(columns)
          ? { quickFilterColumns: [...new Set(columns)] }
          : {}),
        ...(typeof scope === "string" ? { scope } : {}),
      };
    }
    return meta;
  } catch {
    return undefined;
  }
};

/**
 * A set's quick filter fields: its own, else (a set saved before sets
 * carried them, or no set active) the grid's defaults.
 */
export const quickFilterColumnsFor = (
  meta: ColumnSetMetaState,
  setName: string | undefined,
  defaults: readonly string[],
): string[] => [
  ...((setName ? meta[setName]?.quickFilterColumns : undefined) ?? defaults),
];

/**
 * Keeps the meta in step with a change of the column sets: a created set
 * takes the quick filter fields in view, a renamed set keeps its own and a
 * deleted set's are dropped.
 */
export const reconcileColumnSetMeta = (
  meta: ColumnSetMetaState,
  previous: ColumnSetsState,
  next: ColumnSetsState,
  reason: ColumnSetsChangeReason,
  quickFilterColumns: readonly string[],
): ColumnSetMetaState => {
  const before = new Set(previous.columnSets.map(({ name }) => name));
  const after = new Set(next.columnSets.map(({ name }) => name));
  const added = [...after].filter((name) => !before.has(name));
  const removed = [...before].filter((name) => !after.has(name));
  if (added.length === 0 && removed.length === 0) return meta;
  const result: ColumnSetMetaState = { ...meta };
  if (reason === "renamed" && added.length === 1 && removed.length === 1) {
    const [from] = removed;
    const [to] = added;
    if (from in result) result[to] = result[from];
    delete result[from];
    return result;
  }
  for (const name of removed) delete result[name];
  for (const name of added)
    result[name] = { quickFilterColumns: [...quickFilterColumns] };
  return result;
};

/** The column a quick filter clause is on, if it is one column's clause. */
const clauseColumn = (filter: Filter): string | undefined => {
  if ("column" in filter) return filter.column;
  if ("filters" in filter && filter.op === "and" && filter.filters.length) {
    // a between: two clauses on one column
    const columns = new Set(
      filter.filters.map((f) => ("column" in f ? f.column : undefined)),
    );
    const [only] = columns;
    return columns.size === 1 ? only : undefined;
  }
  return undefined;
};

const isSearchClause = (filter: Filter, searchColumns: readonly string[]) => {
  if ("column" in filter)
    return filter.op === "contains" && searchColumns.includes(filter.column);
  return (
    filter.op === "or" &&
    filter.filters.every(
      (f) =>
        "column" in f &&
        f.op === "contains" &&
        searchColumns.includes(f.column),
    )
  );
};

/**
 * The quick filters' combined filter (QuickFilters onQuickFilterChange)
 * split by column, without the Search clause.
 */
export const quickFilterClauses = (
  filter: Filter | undefined,
  searchColumns: readonly string[],
): Record<string, Filter> => {
  const clauses: Record<string, Filter> = {};
  const visit = (f: Filter) => {
    if (isSearchClause(f, searchColumns)) return;
    const column = clauseColumn(f);
    if (column) clauses[column] = f;
    else if ("filters" in f && f.op === "and") f.filters.forEach(visit);
  };
  if (filter) visit(filter);
  return clauses;
};

/**
 * The latest value of every quick filter field: the fields in view take
 * theirs from `clauses` (absent = cleared); fields out of view keep theirs.
 */
export const updateQuickFilterValues = (
  values: Record<string, Filter>,
  clauses: Record<string, Filter>,
  shown: readonly string[],
): Record<string, Filter> => {
  const next: Record<string, Filter> = {};
  for (const [column, f] of Object.entries(values))
    if (!shown.includes(column)) next[column] = f;
  for (const [column, f] of Object.entries(clauses))
    if (shown.includes(column)) next[column] = f;
  return next;
};

/** Values on fields the column set in view doesn't show: "Also applied". */
export const alsoAppliedFilters = (
  values: Record<string, Filter>,
  shown: readonly string[],
) =>
  Object.entries(values)
    .filter(([column]) => !shown.includes(column))
    .map(([column, filter]) => ({ column, filter }));

/** `a` AND each of `more`, flattened; undefined if there are none. */
export const andFilters = (
  a: Filter | undefined,
  more: readonly Filter[],
): Filter | undefined => {
  const all = [a, ...more].filter((f): f is Filter => f !== undefined);
  if (all.length <= 1) return all[0];
  return {
    op: "and",
    filters: all.flatMap((f) =>
      "filters" in f && f.op === "and" && clauseColumn(f) === undefined
        ? f.filters
        : [f],
    ),
  } as Filter;
};

const valueText = (value: unknown) =>
  typeof value === "string" ? value : String(value);

/** "Sector: Energy", "Ccy: GBP, USD", "Mkt Cap $: 1e9–5e9", "P/E: < 12". */
export const quickFilterChipLabel = (
  column: string,
  filter: Filter,
  columns: readonly ColumnDescriptor[],
) => {
  const descriptor = columns.find(({ name }) => name === column);
  const label = descriptor?.label ?? column;
  let value: string;
  if ("values" in filter && Array.isArray(filter.values)) {
    value = filter.values.map(valueText).join(", ");
  } else if ("value" in filter) {
    value =
      filter.op === "="
        ? valueText(filter.value)
        : `${filter.op} ${valueText(filter.value)}`;
  } else if ("filters" in filter) {
    value = filter.filters
      .map((f) => ("value" in f ? valueText(f.value) : ""))
      .join("–");
  } else value = "";
  return `${label}: ${value}`;
};
