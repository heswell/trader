import type {
  DataSource,
  DataSourceFilter,
  DataSourceRow,
} from "@vuu-ui/vuu-data-types";
import type { VuuAggregation, VuuGroupBy } from "@vuu-ui/vuu-protocol-types";
import { metadataKeys, Range } from "@vuu-ui/vuu-utils";
import { useEffect, useMemo, useRef, useState } from "react";

/** A data source row as a `{ column: value }` object (plus the row key). */
export type ViewportRow = Record<string, unknown> & { $key: string };

export interface ViewportRowsOptions {
  /** Don't subscribe (e.g. no instrument selected). Rows are cleared. */
  enabled?: boolean;
  /**
   * Filter (vuu filter syntax). Changing it re-subscribes and clears the
   * rows immediately, so an instrument switch never shows stale rows.
   */
  filter?: string;
  groupBy?: VuuGroupBy;
  aggregations?: VuuAggregation[];
  /** Rows requested from the top of the viewport. Default 100. */
  maxRows?: number;
  /**
   * Coalesce updates to at most one React render per animation frame
   * (default), or render on every viewport message (`"none"`).
   */
  throttle?: "frame" | "none";
}

export interface ViewportRowsState<T extends ViewportRow = ViewportRow> {
  rows: T[];
  /** Total rows in the (filtered) viewport, may exceed `rows.length`. */
  size: number;
  /** True once the first viewport update for the current filter arrived. */
  loaded: boolean;
  /** Incremented on every update that produced a render. */
  version: number;
}

const EMPTY: ViewportRowsState<never> = {
  rows: [],
  size: 0,
  loaded: false,
  version: 0,
};

const raf: (cb: () => void) => unknown =
  typeof requestAnimationFrame === "function"
    ? (cb) => requestAnimationFrame(cb)
    : (cb) => setTimeout(cb, 16);
const cancelRaf = (id: unknown) =>
  typeof cancelAnimationFrame === "function"
    ? cancelAnimationFrame(id as number)
    : clearTimeout(id as ReturnType<typeof setTimeout>);

const toObject = (row: DataSourceRow, columns: string[]): ViewportRow => {
  const out: ViewportRow = { $key: String(row[metadataKeys.KEY]) };
  for (let i = 0; i < columns.length; i++) {
    out[columns[i]] = row[metadataKeys.count + i];
  }
  return out;
};

/**
 * Subscribe a DataSource (from useTradingDataSource) and expose its rows as
 * plain objects, for custom renderers (depth, ladder) that don't use a vuu
 * Table. Subscribed while `enabled`; re-subscribed when `filter`, `groupBy`
 * or `aggregations` change; unsubscribed on unmount. Updates are coalesced
 * per animation frame by default.
 */
export const useViewportRows = <T extends ViewportRow = ViewportRow>(
  dataSource: DataSource,
  {
    enabled = true,
    filter = "",
    groupBy,
    aggregations,
    maxRows = 100,
    throttle = "frame",
  }: ViewportRowsOptions = {},
): ViewportRowsState<T> => {
  const [state, setState] = useState<ViewportRowsState<T>>(EMPTY);
  const groupKey = useMemo(
    () => JSON.stringify([groupBy ?? [], aggregations ?? []]),
    [groupBy, aggregations],
  );
  const store = useRef({
    rows: [] as (T | undefined)[],
    size: 0,
    generation: 0,
    version: 0,
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: groupKey stands in for groupBy/aggregations
  useEffect(() => {
    const s = store.current;
    const generation = ++s.generation;
    s.rows = [];
    s.size = 0;
    setState(EMPTY);
    if (!enabled) return;

    let frame: unknown;
    let loaded = false;
    const flush = () => {
      frame = undefined;
      if (generation !== s.generation) return;
      const rows: T[] = [];
      const n = Math.min(s.size, s.rows.length);
      for (let i = 0; i < n; i++) {
        const row = s.rows[i];
        if (row) rows.push(row);
      }
      setState({ rows, size: s.size, loaded, version: ++s.version });
    };
    const schedule = () => {
      if (throttle === "none") flush();
      else frame ??= raf(flush);
    };

    const filterSpec: DataSourceFilter = { filter };
    dataSource.subscribe(
      {
        range: Range(0, maxRows),
        filterSpec,
        groupBy: groupBy ?? [],
        aggregations: aggregations ?? [],
      },
      (message) => {
        if (generation !== s.generation) return;
        if (message.type === "viewport-update") {
          if (typeof message.size === "number") {
            s.size = message.size;
            if (s.rows.length > s.size) s.rows.length = s.size;
          }
          if (message.rows) {
            const columns = dataSource.columns;
            for (const row of message.rows) {
              const index = row[metadataKeys.IDX] as number;
              if (index < maxRows) {
                s.rows[index] = toObject(row, columns) as T;
              }
            }
          }
          loaded = true;
          schedule();
        } else if (message.type === "viewport-clear") {
          s.rows = [];
          s.size = 0;
          schedule();
        }
      },
    );
    return () => {
      s.generation++;
      if (frame !== undefined) cancelRaf(frame);
      dataSource.unsubscribe();
    };
  }, [dataSource, enabled, filter, groupKey, maxRows, throttle]);

  return state;
};

/** Quote a string literal for a vuu filter expression. */
export const filterString = (value: string) =>
  `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
