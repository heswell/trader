import type { QuickFilterValue, QuickFilterValues } from "@vuu-ui/vuu-filters";
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

/** Values on fields the column set in view doesn't show: "Also applied". */
export const alsoAppliedValues = (
  values: QuickFilterValues,
  shown: readonly string[],
) =>
  Object.entries(values)
    .filter(([column]) => !shown.includes(column))
    .map(([column, value]) => ({ column, value }));

const valueText = (value: unknown) =>
  typeof value === "string" ? value : String(value);

/** "Sector: Energy", "Ccy: GBP, USD", "Mkt Cap $: 1e9–5e9", "P/E: < 12". */
export const quickFilterChipLabel = (
  column: string,
  { op, value }: QuickFilterValue,
  columns: readonly ColumnDescriptor[],
) => {
  const descriptor = columns.find(({ name }) => name === column);
  const label = descriptor?.label ?? column;
  let text: string;
  if (Array.isArray(value)) {
    // a between, applied as the quick filters apply one: either end can be
    // empty
    const [from, to] = value;
    text = from && to ? `${from}–${to}` : from ? from : `< ${to}`;
  } else
    text =
      op === "=" || op === "in"
        ? valueText(value)
        : `${op} ${valueText(value)}`;
  return `${label}: ${text}`;
};
