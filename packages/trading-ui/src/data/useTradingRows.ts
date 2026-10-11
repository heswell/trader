import type { TradingSchemaName } from "@heswell/trading-schemas";
import type {
  DataSource,
  DataSourceCallbackMessage,
  DataSourceRow,
} from "@vuu-ui/vuu-data-types";
import { metadataKeys, Range } from "@vuu-ui/vuu-utils";
import { useEffect, useRef, useState } from "react";
import {
  type TradingDataSourceOptions,
  useTradingDataSource,
} from "./useTradingDataSource";

/** A data source row as `{ column: value }`, plus the row key. */
export type TradingRowObject = Record<string, unknown> & { $key: string };

/** Convert a positional data source row to an object, using `columns` order. */
export const toTradingRowObject = (
  row: DataSourceRow,
  columns: readonly string[],
): TradingRowObject => {
  const result: TradingRowObject = { $key: String(row[metadataKeys.KEY]) };
  for (let i = 0; i < columns.length; i++) {
    result[columns[i]] = row[metadataKeys.count + i];
  }
  return result;
};

export type TradingRowsListener = (
  /** Rows received in this update (changed or newly in range). */
  rows: TradingRowObject[],
  /** Total row count, when the update carries one. */
  size: number | undefined,
) => void;

/**
 * Subscribe a data source to the first `rowCount` rows and call `listener`
 * with each batch of updated rows as objects. Returns an unsubscribe.
 * Use when you need the rows themselves (tickets, notifications) rather than
 * rendering a Table.
 */
export const subscribeTradingRows = (
  dataSource: DataSource,
  rowCount: number,
  listener: TradingRowsListener,
) => {
  const columns = dataSource.columns;
  const callback = (message: DataSourceCallbackMessage) => {
    if (message.type === "viewport-update") {
      const rows = message.rows?.map((r) => toTradingRowObject(r, columns));
      if (rows?.length || message.size !== undefined) {
        listener(rows ?? [], message.size);
      }
    }
  };
  dataSource.subscribe({ range: Range(0, rowCount) }, callback);
  return () => dataSource.unsubscribe();
};

export interface TradingRowsOptions extends TradingDataSourceOptions {
  /** Rows to keep in range (default 100). */
  rowCount?: number;
  /** Vuu filter expression, applied (and re-applied) when it changes. */
  filter?: string;
  /** Don't subscribe while false. */
  enabled?: boolean;
}

/**
 * The first `rowCount` rows of a trading table as objects (in data source
 * order), kept up to date. Also returns the subscribed data source, which can
 * be used for RPCs (`sendTradingRpc`).
 */
export const useTradingRows = (
  table: TradingSchemaName,
  {
    rowCount = 100,
    filter,
    enabled = true,
    ...options
  }: TradingRowsOptions = {},
) => {
  const dataSource = useTradingDataSource(table, {
    ...options,
    filterSpec: { filter: filter ?? "" },
  });
  const [rows, setRows] = useState<TradingRowObject[]>([]);
  const filterRef = useRef(filter);

  useEffect(() => {
    if (filterRef.current !== filter) {
      filterRef.current = filter;
      setRows([]);
      dataSource.filter = { filter: filter ?? "" };
    }
  }, [dataSource, filter]);

  useEffect(() => {
    if (!enabled) return;
    let byIndex: TradingRowObject[] = [];
    const columns = dataSource.columns;
    dataSource.subscribe(
      { range: Range(0, rowCount) },
      (message: DataSourceCallbackMessage) => {
        if (message.type !== "viewport-update") return;
        let next = byIndex;
        if (message.size !== undefined && message.size < next.length) {
          next = next.slice(0, message.size);
        }
        if (message.rows?.length) {
          next = next === byIndex ? next.slice() : next;
          for (const row of message.rows) {
            const index = row[metadataKeys.IDX];
            if (index < rowCount)
              next[index] = toTradingRowObject(row, columns);
          }
        }
        if (next !== byIndex) {
          byIndex = next;
          setRows(next.filter(Boolean));
        }
      },
    );
    return () => dataSource.unsubscribe();
  }, [dataSource, enabled, rowCount]);

  return { dataSource, rows };
};
