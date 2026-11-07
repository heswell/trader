import { Table } from "@vuu-ui/vuu-table";
import type {
  ColumnDescriptor,
  TableConfig,
  TableRowSelectHandler,
} from "@vuu-ui/vuu-table-types";
import cx from "clsx";
import {
  forwardRef,
  type HTMLAttributes,
  useCallback,
  useEffect,
  useState,
} from "react";
import { useTradingDataSource } from "../../data/useTradingDataSource";
import { filterString } from "../../utils/filters";
import { registerSparklineRenderer } from "../Sparkline/Sparkline";
import {
  registerTradingCellRenderers,
  TradingRenderer,
} from "../TradingCellRenderers";
import {
  type SelectedMetric,
  serverMetricsClass,
  useServerMetricsCss,
} from "./useServerMetricsCss";

registerTradingCellRenderers();
registerSparklineRenderer();

/** Component filter offered by the MetricsGrid toolbar ("" = all). */
export const METRICS_COMPONENTS = [
  "",
  "exchange",
  "publisher",
  "gateway",
  "oms",
  "vuu",
] as const;

const COLUMNS = [
  "id",
  "component",
  "name",
  "kind",
  "unit",
  "value",
  "rate",
  "mean",
  "p50",
  "p99",
  "max",
  "lastUpdate",
];

const right = { align: "right" as const };
const number = (decimals: number) => ({
  ...right,
  type: { name: "number" as const, formatting: { decimals } },
});

/** A client column drawing recent values of `valueColumn` (see SparklineCell). */
export const trendColumn = (
  name: string,
  valueColumn: string,
  label: string,
): ColumnDescriptor => ({
  name,
  label,
  source: "client",
  sortable: false,
  width: 100,
  type: {
    name: "string",
    renderer: {
      name: "trading.sparkline",
      componentProps: { valueColumn, length: 60, bucketMs: 0 },
    },
  },
});

const tableConfig: TableConfig = {
  columnDefaultWidth: 80,
  rowSeparators: true,
  columns: [
    { name: "component", width: 90 },
    { name: "name", width: 170 },
    { name: "kind", width: 70 },
    { name: "value", ...number(0), width: 100 },
    { name: "rate", label: "/s", ...number(1), width: 90 },
    trendColumn("rateTrend", "rate", "/s trend"),
    { name: "unit", width: 60 },
    { name: "p50", ...number(1) },
    { name: "p99", ...number(1) },
    trendColumn("p99Trend", "p99", "p99 trend"),
    { name: "max", ...number(0) },
    { name: "mean", ...number(1) },
    {
      name: "lastUpdate",
      label: "Updated",
      width: 110,
      type: { name: "string", renderer: { name: TradingRenderer.Time } },
    },
  ],
};

export interface MetricsGridProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "onSelect"> {
  /** Initial component filter ("" = all). */
  defaultComponent?: (typeof METRICS_COMPONENTS)[number];
  /** Called with the selected metric (undefined when deselected). */
  onSelectMetric?: (metric: SelectedMetric | undefined) => void;
}

/**
 * Every named metric from `METRICS.metrics` (sim-admin only): counters with
 * their total and rate, gauges, and timers with their call rate and latency
 * percentiles (µs), each with a trend of its recent rate and p99. Selecting a
 * row reports the metric, e.g. to chart its history.
 */
export const MetricsGrid = forwardRef<HTMLDivElement, MetricsGridProps>(
  function MetricsGrid(
    { className, defaultComponent = "", onSelectMetric, ...htmlAttributes },
    ref,
  ) {
    useServerMetricsCss();
    const [component, setComponent] = useState<string>(defaultComponent);
    const dataSource = useTradingDataSource("metrics", {
      columns: COLUMNS,
      sort: {
        sortDefs: [
          { column: "component", sortType: "A" },
          { column: "name", sortType: "A" },
        ],
      },
      ...(defaultComponent
        ? {
            filterSpec: {
              filter: `component = ${filterString(defaultComponent)}`,
            },
          }
        : {}),
    });
    useEffect(() => {
      const filter = component ? `component = ${filterString(component)}` : "";
      if (dataSource.filter.filter !== filter) dataSource.filter = { filter };
    }, [component, dataSource]);
    const handleSelect = useCallback<TableRowSelectHandler>(
      (row) => {
        onSelectMetric?.(
          row?.isLeaf
            ? {
                id: String(row.id),
                kind: row.kind as SelectedMetric["kind"],
                unit: String(row.unit),
              }
            : undefined,
        );
      },
      [onSelectMetric],
    );

    return (
      <div
        {...htmlAttributes}
        className={cx(serverMetricsClass, className)}
        data-testid="trading-metrics-grid"
        ref={ref}
      >
        <div className={`${serverMetricsClass}-toolbar`}>
          <label>
            Component{" "}
            <select
              onChange={(e) => setComponent(e.target.value)}
              value={component}
            >
              {METRICS_COMPONENTS.map((c) => (
                <option key={c} value={c}>
                  {c || "All"}
                </option>
              ))}
            </select>
          </label>
        </div>
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
  },
);
