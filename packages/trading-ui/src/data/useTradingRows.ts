import type { TradingSchemaName } from "@heswell/trading-schemas";
import type { DataSource } from "@vuu-ui/vuu-data-types";
import {
  type DataSourceRows,
  type TradingRow,
  type UseDataSourceRowsOptions,
  useDataSourceRows,
} from "./useDataSourceRows";
import {
  type TradingDataSourceOptions,
  useTradingDataSource,
} from "./useTradingDataSource";

export interface TradingRowsOptions
  extends Omit<TradingDataSourceOptions, "aggregations" | "groupBy">,
    UseDataSourceRowsOptions {}

export interface TradingRows<T extends TradingRow = TradingRow>
  extends DataSourceRows<T> {
  /** The subscribed data source (usable for RPCs: `sendTradingRpc`). */
  dataSource: DataSource;
}

/**
 * useTradingDataSource + useDataSourceRows in one call: the rows of a
 * trading table (first `rowCount`, default 100) as objects, kept up to date.
 * `filter` (default: none), `groupBy`, `aggregations`, `enabled` and
 * `throttle` behave as in useDataSourceRows (updates are frame-coalesced
 * unless `throttle: "none"`);
 * other options (columns, sort, ...) are initial data source config.
 */
export const useTradingRows = <T extends TradingRow = TradingRow>(
  table: TradingSchemaName,
  {
    aggregations,
    enabled,
    filter,
    groupBy,
    range,
    rowCount,
    throttle,
    ...options
  }: TradingRowsOptions = {},
): TradingRows<T> => {
  const dataSource = useTradingDataSource(table, {
    ...options,
    filterSpec: { filter: filter ?? "" },
    ...(groupBy !== undefined ? { groupBy } : {}),
    ...(aggregations !== undefined ? { aggregations } : {}),
  });
  const rows = useDataSourceRows<T>(dataSource, {
    aggregations,
    enabled,
    filter: filter ?? "",
    groupBy,
    range,
    rowCount,
    throttle,
  });
  return { ...rows, dataSource };
};
