import type { TradingSchemaName } from "@heswell/trading-schemas";
import { useData } from "@vuu-ui/core";
import type {
  DataSource,
  DataSourceConstructorProps,
} from "@vuu-ui/vuu-data-types";
import { useEffect, useMemo } from "react";
import { tradingColumnNames, tradingVuuTable } from "./tradingTables";

export type TradingDataSourceOptions = Omit<
  DataSourceConstructorProps,
  "table"
>;

/**
 * A DataSource for a trading table from the nearest data provider (local
 * test data, remote server or portal host - see TradingDataProvider).
 *
 * `options` (columns, sort, filterSpec, groupBy, aggregations, ...) are
 * initial config only: the data source is created once per table/provider.
 * Change config afterwards through the DataSource (`ds.sort = ...`) or let
 * a vuu Table drive it. Columns default to every column of the schema.
 * The data source is unsubscribed on unmount.
 */
export const useTradingDataSource = (
  table: TradingSchemaName,
  options: TradingDataSourceOptions = {},
): DataSource => {
  const { VuuDataSource } = useData();
  // biome-ignore lint/correctness/useExhaustiveDependencies: options are initial config only
  const dataSource = useMemo(
    () =>
      new VuuDataSource({
        columns: tradingColumnNames(table),
        ...options,
        table: tradingVuuTable(table),
      }),
    [VuuDataSource, table],
  );
  useEffect(() => () => dataSource.unsubscribe(), [dataSource]);
  return dataSource;
};
