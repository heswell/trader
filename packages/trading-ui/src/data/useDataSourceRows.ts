import type {
  DataSource,
  DataSourceRow,
  DataSourceSubscribeProps,
} from "@vuu-ui/vuu-data-types";
import type { VuuAggregation, VuuGroupBy } from "@vuu-ui/vuu-protocol-types";
import { metadataKeys, Range } from "@vuu-ui/vuu-utils";
import { useEffect, useMemo, useRef, useState } from "react";

/**
 * A data source row as a `{ column: value }` object, plus its key, index
 * in the viewport and (for grouped data) tree position.
 */
export type TradingRow = Record<string, unknown> & {
  readonly $key: string;
  readonly $index: number;
  readonly $isLeaf: boolean;
  readonly $depth: number;
};

/** Convert a positional data source row to a TradingRow (`columns` order). */
export const toTradingRow = (
  row: DataSourceRow,
  columns: readonly string[],
): TradingRow => {
  const result: Record<string, unknown> = {
    $key: String(row[metadataKeys.KEY]),
    $index: row[metadataKeys.IDX],
    $isLeaf: row[metadataKeys.IS_LEAF],
    $depth: row[metadataKeys.DEPTH],
  };
  for (let i = 0; i < columns.length; i++) {
    result[columns[i]] = row[metadataKeys.count + i];
  }
  return result as TradingRow;
};

export interface DataSourceRowsConfig {
  /** Rows to keep, [from, to). Default [0, rowCount). */
  range?: { from: number; to: number };
  /** Shorthand for `range: { from: 0, to: rowCount }`. Default 100. */
  rowCount?: number;
  /**
   * Vuu filter expression to subscribe with. Leave undefined to keep the
   * data source's own filter (e.g. one a caller sets with `ds.filter`).
   */
  filter?: string;
  /** Subscribe grouped (undefined: keep the data source's own). */
  groupBy?: VuuGroupBy;
  aggregations?: VuuAggregation[];
}

export interface DataSourceRowsUpdate<T extends TradingRow = TradingRow> {
  /** Every row held in range, in viewport order (computed on first read). */
  readonly rows: T[];
  /** Rows received in this message (changed or newly in range). */
  readonly updated: T[];
  /** Total rows of the (filtered) data source, may exceed `rows.length`. */
  readonly size: number;
  /** The size carried by this message, if any. */
  readonly messageSize: number | undefined;
  /** False until the first viewport update (an empty table is loaded too). */
  readonly loaded: boolean;
  /** This message cleared the viewport (`viewport-clear`). */
  readonly cleared: boolean;
}

const rangeOf = ({ range, rowCount = 100 }: DataSourceRowsConfig) =>
  range ?? { from: 0, to: rowCount };

/**
 * The single row primitive behind every non-Table consumer of trading data
 * (React or not): subscribe `dataSource` to a range and receive rows as
 * objects. The listener is called synchronously for every viewport message.
 * Returns unsubscribe (which also unsubscribes the data source).
 */
export const subscribeTradingRows = <T extends TradingRow = TradingRow>(
  dataSource: DataSource,
  config: DataSourceRowsConfig,
  listener: (update: DataSourceRowsUpdate<T>) => void,
): (() => void) => {
  const { from, to } = rangeOf(config);
  const held = new Map<number, T>();
  let size = 0;
  let loaded = false;
  let active = true;

  const emit = (
    updated: T[],
    messageSize: number | undefined,
    cleared = false,
  ) => {
    let rows: T[] | undefined;
    const currentSize = size;
    listener({
      get rows() {
        if (!rows) {
          rows = [];
          const end = Math.min(to, currentSize);
          for (let i = from; i < end; i++) {
            const row = held.get(i);
            if (row) rows.push(row);
          }
        }
        return rows;
      },
      updated,
      size: currentSize,
      messageSize,
      loaded,
      cleared,
    });
  };

  const props: DataSourceSubscribeProps = {
    range: Range(from, to),
    ...(config.filter !== undefined
      ? { filterSpec: { filter: config.filter } }
      : {}),
    ...(config.groupBy !== undefined ? { groupBy: config.groupBy } : {}),
    ...(config.aggregations !== undefined
      ? { aggregations: config.aggregations }
      : {}),
  };

  dataSource.subscribe(props, (message) => {
    if (!active) return;
    if (message.type === "viewport-update") {
      if (typeof message.size === "number") {
        size = message.size;
        for (const index of held.keys()) {
          if (index >= size) held.delete(index);
        }
      }
      const updated: T[] = [];
      if (message.rows) {
        const columns = dataSource.columns;
        for (const row of message.rows) {
          const index = row[metadataKeys.IDX] as number;
          if (index >= from && index < to) {
            const value = toTradingRow(row, columns) as T;
            held.set(index, value);
            updated.push(value);
          }
        }
      }
      loaded = true;
      emit(updated, message.size);
    } else if (message.type === "viewport-clear") {
      held.clear();
      size = 0;
      emit([], 0, true);
    }
  });
  return () => {
    active = false;
    dataSource.unsubscribe();
  };
};

export interface UseDataSourceRowsOptions extends DataSourceRowsConfig {
  /** Subscribe only while true (default true). Rows are cleared. */
  enabled?: boolean;
  /**
   * Coalesce updates to at most one render per animation frame (default),
   * or render on every viewport message (`"none"`).
   */
  throttle?: "frame" | "none";
}

export interface DataSourceRows<T extends TradingRow = TradingRow> {
  /** Rows in viewport order for the subscribed range. */
  rows: T[];
  /** Total rows of the (filtered) data source, may exceed `rows.length`. */
  size: number;
  /** True once the first viewport update of the current subscription arrived. */
  loaded: boolean;
  /** Incremented on every update that rendered. */
  version: number;
}

const EMPTY: DataSourceRows<never> = {
  rows: [],
  size: 0,
  loaded: false,
  version: 0,
};

const requestFrame: (cb: () => void) => unknown =
  typeof requestAnimationFrame === "function"
    ? (cb) => requestAnimationFrame(cb)
    : (cb) => setTimeout(cb, 16);
const cancelFrame = (id: unknown) =>
  typeof cancelAnimationFrame === "function"
    ? cancelAnimationFrame(id as number)
    : clearTimeout(id as ReturnType<typeof setTimeout>);

/**
 * Rows of a data source you own (from useTradingDataSource, not one a vuu
 * Table drives) as objects, for custom renderers (depth, ladder, tape) and
 * headless logic. Subscribed while `enabled`; re-subscribed - with the rows
 * cleared at once, so an instrument switch never shows stale rows - when
 * `filter`, `groupBy`, `aggregations` or the range change; unsubscribed on
 * unmount. Bursts of updates cost one render per animation frame.
 */
export const useDataSourceRows = <T extends TradingRow = TradingRow>(
  dataSource: DataSource | undefined,
  {
    enabled = true,
    throttle = "frame",
    ...config
  }: UseDataSourceRowsOptions = {},
): DataSourceRows<T> => {
  const [state, setState] = useState<DataSourceRows<T>>(EMPTY);
  const { from, to } = rangeOf(config);
  const configKey = useMemo(
    () =>
      JSON.stringify([
        config.filter ?? null,
        config.groupBy ?? null,
        config.aggregations ?? null,
      ]),
    [config.filter, config.groupBy, config.aggregations],
  );
  const configRef = useRef(config);
  configRef.current = config;
  const versionRef = useRef(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: configKey stands in for filter / groupBy / aggregations
  useEffect(() => {
    setState((current) => (current === EMPTY ? current : EMPTY));
    if (!dataSource || !enabled) return;
    let frame: unknown;
    let latest: DataSourceRowsUpdate<T> | undefined;
    const flush = () => {
      frame = undefined;
      if (!latest) return;
      const { rows, size, loaded } = latest;
      versionRef.current += 1;
      setState({ rows, size, loaded, version: versionRef.current });
    };
    const unsubscribe = subscribeTradingRows<T>(
      dataSource,
      {
        ...configRef.current,
        range: { from, to },
      },
      (update) => {
        latest = update;
        if (throttle === "none") flush();
        else frame ??= requestFrame(flush);
      },
    );
    return () => {
      latest = undefined;
      if (frame !== undefined) cancelFrame(frame);
      unsubscribe();
    };
  }, [dataSource, enabled, configKey, from, to, throttle]);

  return state;
};
