import type { TradingSchemaName } from "@heswell/trading-schemas";
import { useData } from "@vuu-ui/core";
import type { DataSource } from "@vuu-ui/vuu-data-types";
import { useMemo } from "react";
import { tradingColumnNames, tradingVuuTable } from "./tradingTables";

export interface ChartDataSourceOptions {
  /** Columns to subscribe to (default: every column of the schema). */
  columns?: string[];
  /** Vuu filter expression, e.g. `ric = "VOD.L" and interval = "1m"`. */
  filter?: string;
  /** Sort column; charts read the first `maxRows` rows so sort newest first. */
  sort?: { column: string; direction?: "A" | "D" };
  /**
   * When true no DataSource is created (returns undefined), e.g. while no
   * instrument is selected.
   */
  disabled?: boolean;
}

/**
 * A DataSource dedicated to one vuu-chart (or one chart overlay).
 *
 * vuu-chart subscribes with no filter or sort of its own and *unsubscribes*
 * its DataSources on unmount or when a DataSource prop changes, so charts
 * must never share a DataSource with a table or another chart. This hook
 * creates a fresh DataSource whenever table, filter, sort or columns change,
 * with the filter and sort applied server-side (charts only read the first
 * `maxRows` rows). Unsubscribing is left to the chart.
 */
export const useChartDataSource = (
  table: TradingSchemaName,
  { columns, disabled = false, filter, sort }: ChartDataSourceOptions = {},
): DataSource | undefined => {
  const { VuuDataSource } = useData();
  const columnKey = columns?.join(",");
  const sortColumn = sort?.column;
  const sortType = sort?.direction ?? "D";
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by columnKey, not the array identity
  return useMemo(
    () =>
      disabled
        ? undefined
        : new VuuDataSource({
            columns: columns ?? tradingColumnNames(table),
            table: tradingVuuTable(table),
            ...(filter ? { filterSpec: { filter } } : undefined),
            ...(sortColumn
              ? { sort: { sortDefs: [{ column: sortColumn, sortType }] } }
              : undefined),
          }),
    [VuuDataSource, table, columnKey, disabled, filter, sortColumn, sortType],
  );
};
