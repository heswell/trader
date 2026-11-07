import { CartesianChart, type CartesianSeries } from "@vuu-ui/vuu-chart";
import cx from "clsx";
import { forwardRef, type HTMLAttributes } from "react";
import { useChartDataSource } from "../../data/useChartDataSource";
import { filterString } from "../../utils/filters";
import {
  ChartFrame,
  chartFrameClass,
  disableSeriesAnimation,
} from "../ChartFrame/ChartFrame";
import type { SelectedMetric } from "./useServerMetricsCss";

const classBase = "tradingMetricHistoryChart";

const X_AXIS = { columnName: "time", type: "time" } as const;
const COLUMNS = ["id", "metric", "time", "value", "rate", "p50", "p99", "max"];

/** What is charted for each kind of metric. */
export const metricHistorySeries = (
  kind: SelectedMetric["kind"],
): CartesianSeries[] =>
  kind === "timer"
    ? [
        { type: "line", columnName: "p50", name: "p50", color: "palette-1" },
        { type: "line", columnName: "p99", name: "p99", color: "palette-2" },
        { type: "line", columnName: "max", name: "max", color: "palette-3" },
      ]
    : kind === "counter"
      ? [{ type: "line", columnName: "rate", name: "/s", color: "palette-1" }]
      : [
          {
            type: "line",
            columnName: "value",
            name: "value",
            color: "palette-1",
          },
        ];

/** The y-axis name: the unit, per second for a counter. */
export const metricHistoryAxis = ({ kind, unit }: SelectedMetric) =>
  kind === "counter" ? `${unit || "count"} /s` : unit || "value";

export interface MetricHistoryChartProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  /** The metric to chart; a message is shown when undefined. */
  metric?: SelectedMetric;
}

/**
 * The recent history of one metric from `METRICS.metricsHistory` (sim-admin
 * only, 5 minutes by default): latency p50 / p99 / max for a timer, the rate
 * for a counter, the value for a gauge.
 */
export const MetricHistoryChart = forwardRef<
  HTMLDivElement,
  MetricHistoryChartProps
>(function MetricHistoryChart({ className, metric, ...htmlAttributes }, ref) {
  const dataSource = useChartDataSource("metricsHistory", {
    columns: COLUMNS,
    disabled: !metric,
    filter: metric ? `metric = ${filterString(metric.id)}` : undefined,
    sort: { column: "time" },
  });
  return (
    <ChartFrame
      {...htmlAttributes}
      className={cx(classBase, className)}
      data-metric={metric?.id}
      message={dataSource ? undefined : "Select a metric"}
      ref={ref}
      toolbar={
        <span className={`${chartFrameClass}-title`}>
          {metric ? `${metric.id} history` : "Metric history"}
        </span>
      }
    >
      {dataSource && metric ? (
        <CartesianChart
          aria-label={`${metric.id} history`}
          dataSource={dataSource}
          echartsOptions={disableSeriesAnimation}
          series={metricHistorySeries(metric.kind)}
          xAxis={X_AXIS}
          yAxes={[{ name: metricHistoryAxis(metric), scale: true }]}
        />
      ) : null}
    </ChartFrame>
  );
});
