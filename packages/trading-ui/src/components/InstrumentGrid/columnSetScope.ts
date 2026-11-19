import type { ColumnSet, ColumnSetsState } from "@vuu-ui/vuu-table-extras";
import type { ColumnSetMetaState } from "./columnSetMeta";

/** The set last shown in each scope (ALL_INSTRUMENTS or a watchlist id). */
export type LastColumnSetState = Record<string, string>;

export const LAST_COLUMN_SET_SETTINGS_KEY =
  "trading.instrumentGrid.lastColumnSet";

/** Defensive parse: persisted settings can come from any version / host. */
export const parseLastColumnSet = (
  json: string | null | undefined,
): LastColumnSetState | undefined => {
  if (!json) return undefined;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return undefined;
    const result: LastColumnSetState = {};
    for (const [scope, name] of Object.entries(parsed))
      if (typeof name === "string") result[scope] = name;
    return result;
  } catch {
    return undefined;
  }
};

export interface ScopedColumnSets {
  /** Sets in every scope, in model order. */
  shared: string[];
  /** Sets only in this scope, in model order (after a divider). */
  scoped: string[];
}

/** The sets a scope shows: the shared ones, then its own. */
export const columnSetsInScope = (
  columnSets: readonly Pick<ColumnSet, "name">[],
  meta: ColumnSetMetaState,
  scope: string,
): ScopedColumnSets => {
  const shared: string[] = [];
  const scoped: string[] = [];
  for (const { name } of columnSets) {
    const setScope = meta[name]?.scope;
    if (setScope === undefined) shared.push(name);
    else if (setScope === scope) scoped.push(name);
  }
  return { scoped, shared };
};

/** Shared then scoped: the tab order, and what Alt+1..9 count. */
export const tabOrder = ({ scoped, shared }: ScopedColumnSets) => [
  ...shared,
  ...scoped,
];

/**
 * The set to show on entering a scope: the one last shown there, else the
 * set in view if the scope has it, else the scope's first set.
 */
export const columnSetForScope = (
  sets: ScopedColumnSets,
  lastSet: LastColumnSetState,
  scope: string,
  active: string | undefined,
): string | undefined => {
  const names = tabOrder(sets);
  const last = lastSet[scope];
  if (last && names.includes(last)) return last;
  if (active && names.includes(active)) return active;
  return names[0];
};

/** Shares a set with every scope, or keeps it to one. */
export const setColumnSetScope = (
  meta: ColumnSetMetaState,
  name: string,
  scope: string | undefined,
): ColumnSetMetaState => {
  const { scope: _, ...rest } = meta[name] ?? {};
  return { ...meta, [name]: scope === undefined ? rest : { ...rest, scope } };
};

/** The sets only in `scope` (as a watchlist is deleted). */
export const columnSetsOnlyIn = (meta: ColumnSetMetaState, scope: string) =>
  Object.entries(meta)
    .filter(([, m]) => m.scope === scope)
    .map(([name]) => name);

/** "Prices copy", "Prices copy 2", ... not yet a set name. */
export const copyName = (name: string, existing: readonly string[]) => {
  const taken = new Set(existing.map((n) => n.toLowerCase()));
  const base = `${name} copy`;
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++)
    if (!taken.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`;
};

/**
 * Keeps the last-set record in step with a change of the column sets: the
 * active set is recorded for the scope in view, a renamed set keeps its
 * place and a deleted set is forgotten.
 */
export const followColumnSets = (
  last: LastColumnSetState,
  previous: ColumnSetsState,
  next: ColumnSetsState,
  scope: string,
): LastColumnSetState => {
  const before = new Set(previous.columnSets.map(({ name }) => name));
  const after = new Set(next.columnSets.map(({ name }) => name));
  const added = [...after].filter((name) => !before.has(name));
  const removed = [...before].filter((name) => !after.has(name));
  const renamed =
    added.length === 1 && removed.length === 1
      ? { from: removed[0], to: added[0] }
      : undefined;
  let result = last;
  for (const [s, name] of Object.entries(last)) {
    if (renamed && name === renamed.from)
      result = { ...result, [s]: renamed.to };
    else if (!after.has(name)) {
      const { [s]: _, ...rest } = result;
      result = rest;
    }
  }
  const active = next.activeColumnSet;
  if (active && result[scope] !== active)
    result = { ...result, [scope]: active };
  return result;
};
