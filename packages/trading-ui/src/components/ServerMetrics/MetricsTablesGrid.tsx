import { Table } from "@vuu-ui/vuu-table";
import type {
  TableConfig,
  TableRowSelectHandler,
} from "@vuu-ui/vuu-table-types";
import cx from "clsx";
import { forwardRef, type HTMLAttributes, useCallback } from "react";
import { useTradingDataSource } from "../../data/useTradingDataSource";
import { trendColumn } from "./MetricsGrid";
import {
  type SelectedMetric,
  serverMetricsClass,
  useServerMetricsCss,
} from "./useServerMetricsCss";

const COLUMNS = [
  "id",
  "module",
  "table",
  "rows",
  "counted",
  "writes",
  "writesPerSec",
];

const number = (decimals: number) => ({
  align: "right" as const,
  type: { name: "number" as const, formatting: { decimals } },
});

const tableConfig: TableConfig = {
  columnDefaultWidth: 90,
  rowSeparators: true,
  columns: [
    { name: "module", width: 90 },
    { name: "table", width: 150 },
    { name: "rows", ...number(0) },
    {
      name: "writesPerSec",
      label: "Writes /s",
      ...number(1),
      width: 100,
    },
    trendColumn("writesTrend", "writesPerSec", "Writes trend"),
    { name: "writes", ...number(0), width: 110 },
    { name: "counted", width: 80 },
  ],
};

export interface MetricsTablesGridProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "onSelect"> {
  /**
   * Called with the selected table's writes as a metric (`table.<id>`),
   * when its writes are counted; undefined otherwise.
   */
  onSelectMetric?: (metric: SelectedMetric | undefined) => void;
}

/**
 * Every Vuu table on the server from `METRICS.metricsTables` (sim-admin
 * only): row counts, and writes per second for the tables trader's
 * publishers count, busiest first.
 */
export const MetricsTablesGrid = forwardRef<
  HTMLDivElement,
  MetricsTablesGridProps
>(function MetricsTablesGrid(
  { className, onSelectMetric, ...htmlAttributes },
  ref,
) {
  useServerMetricsCss();
  const dataSource = useTradingDataSource("metricsTables", {
    columns: COLUMNS,
    sort: {
      sortDefs: [
        { column: "writesPerSec", sortType: "D" },
        { column: "rows", sortType: "D" },
      ],
    },
  });
  const handleSelect = useCallback<TableRowSelectHandler>(
    (row) => {
      onSelectMetric?.(
        row?.isLeaf && row.counted
          ? { id: `table.${String(row.id)}`, kind: "counter", unit: "writes" }
          : undefined,
      );
    },
    [onSelectMetric],
  );
  return (
    <div
      {...htmlAttributes}
      className={cx(serverMetricsClass, className)}
      data-testid="trading-metrics-tables-grid"
      ref={ref}
    >
      <div className={`${serverMetricsClass}-table`}>
        <Table
          config={tableConfig}
          dataSource={dataSource}
          onSelect={handleSelect}
          selectionModel="single"
        />
      </div>
    </div>
  );
});
