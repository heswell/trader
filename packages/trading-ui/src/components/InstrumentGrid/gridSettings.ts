import type { FilterState } from "@vuu-ui/vuu-filter-types";
import {
  type ColumnSet,
  type ColumnSetsState,
  NO_COLUMN_SETS,
} from "@vuu-ui/vuu-table-extras";
import { useCallback, useEffect, useState } from "react";
import type { UserSettingsStorage } from "../../utils/userSettingsStorage";

export const COLUMN_SETS_SETTINGS_KEY = "trading.instrumentGrid.columnSets";
export const FILTERS_SETTINGS_KEY = "trading.instrumentGrid.filters";
export const VIEW_SETTINGS_KEY = "trading.instrumentGrid.view";

/** View settings from the panel settings (gear) menu and the link column header. */
export interface GridViewSettings {
  filterBar: boolean;
  footer: boolean;
  /** Pin rows linked to a channel above the scrolling rows. */
  pinLinked: boolean;
}

export const DEFAULT_VIEW_SETTINGS: GridViewSettings = Object.freeze({
  filterBar: true,
  footer: true,
  pinLinked: true,
});

/** Defensive parse: unknown or missing fields keep their default. */
export const parseViewSettings = (
  json: string | null | undefined,
): GridViewSettings | undefined => {
  if (!json) return undefined;
  try {
    const parsed = JSON.parse(json) as Partial<GridViewSettings> | null;
    if (!parsed || typeof parsed !== "object") return undefined;
    return {
      filterBar:
        typeof parsed.filterBar === "boolean"
          ? parsed.filterBar
          : DEFAULT_VIEW_SETTINGS.filterBar,
      footer:
        typeof parsed.footer === "boolean"
          ? parsed.footer
          : DEFAULT_VIEW_SETTINGS.footer,
      pinLinked:
        typeof parsed.pinLinked === "boolean"
          ? parsed.pinLinked
          : DEFAULT_VIEW_SETTINGS.pinLinked,
    };
  } catch {
    return undefined;
  }
};

/** Settings are per grid when it has an id, so differently configured grids keep their own. */
export const gridSettingsKey = (key: string, id?: string) =>
  id ? `${key}:${id}` : key;

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((v) => typeof v === "string");

/** Defensive parse: persisted settings can come from any version / host. */
export const parseColumnSets = (
  json: string | null | undefined,
): ColumnSetsState | undefined => {
  if (!json) return undefined;
  try {
    const parsed = JSON.parse(json) as Partial<ColumnSetsState>;
    if (!Array.isArray(parsed.columnSets)) return undefined;
    const columnSets: ColumnSet[] = [];
    for (const set of parsed.columnSets as Partial<ColumnSet>[]) {
      if (
        set &&
        typeof set.name === "string" &&
        isStringArray(set.columns) &&
        !columnSets.some(({ name }) => name === set.name)
      ) {
        columnSets.push({
          name: set.name,
          columns: set.columns,
          savedColumns: isStringArray(set.savedColumns)
            ? set.savedColumns
            : set.columns,
        });
      }
    }
    const activeColumnSet = columnSets.some(
      ({ name }) => name === parsed.activeColumnSet,
    )
      ? parsed.activeColumnSet
      : undefined;
    return { columnSets, activeColumnSet };
  } catch {
    return undefined;
  }
};

const isFilterLike = (value: unknown) =>
  value !== null &&
  typeof value === "object" &&
  (("column" in value && "op" in value) ||
    ("op" in value && "filters" in value));

/** Defensive parse of the FilterBar's saved filters. */
export const parseFilterState = (
  json: string | null | undefined,
): FilterState | undefined => {
  if (!json) return undefined;
  try {
    const parsed = JSON.parse(json) as Partial<FilterState>;
    if (!Array.isArray(parsed.filters) || !parsed.filters.every(isFilterLike))
      return undefined;
    const activeIndices = Array.isArray(parsed.activeIndices)
      ? parsed.activeIndices.filter(
          (i): i is number =>
            Number.isInteger(i) && i >= 0 && i < (parsed.filters?.length ?? 0),
        )
      : [];
    return { filters: parsed.filters, activeIndices };
  } catch {
    return undefined;
  }
};

/** Column sets offered before the user has saved any. */
export const defaultColumnSets = (
  watchlistColumns: readonly string[],
  screeningColumns: readonly string[],
): ColumnSetsState => {
  if (screeningColumns.length === 0) return NO_COLUMN_SETS;
  const set = (name: string, columns: readonly string[]): ColumnSet => ({
    name,
    columns: [...columns],
    savedColumns: [...columns],
  });
  return {
    activeColumnSet: "Watchlist",
    columnSets: [
      set("Watchlist", watchlistColumns),
      set("Screening", screeningColumns),
    ],
  };
};

export interface StoredSetting<T> {
  /** False until the (possibly asynchronous) stored value has been read. */
  loaded: boolean;
  /** The stored value, undefined if there is none or it can't be read. */
  value: T | undefined;
  save: (value: T) => void;
}

/**
 * A JSON setting read once from `storage` (per key) and written on save.
 * A storage failure leaves the setting unsaved, never throws.
 */
export const useStoredSetting = <T>(
  storage: UserSettingsStorage,
  key: string,
  parse: (json: string | null | undefined) => T | undefined,
): StoredSetting<T> => {
  const [state, setState] = useState<{
    key: string;
    loaded: boolean;
    value: T | undefined;
  }>({ key, loaded: false, value: undefined });

  useEffect(() => {
    let cancelled = false;
    setState({ key, loaded: false, value: undefined });
    Promise.resolve()
      .then(() => storage.getItem(key))
      .catch(() => null)
      .then((json) => {
        if (!cancelled) setState({ key, loaded: true, value: parse(json) });
      });
    return () => {
      cancelled = true;
    };
  }, [storage, key, parse]);

  const save = useCallback(
    (value: T) => {
      try {
        void Promise.resolve(storage.setItem(key, JSON.stringify(value))).catch(
          () => undefined,
        );
      } catch {
        // storage unavailable: the setting is not persisted
      }
    },
    [storage, key],
  );

  return {
    loaded: state.loaded && state.key === key,
    value: state.key === key ? state.value : undefined,
    save,
  };
};
