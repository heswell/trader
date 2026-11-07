import { useComponentCssInjection } from "@salt-ds/styles";
import { useWindow } from "@salt-ds/window";
import serverMetricsCss from "./ServerMetrics.css";

export const serverMetricsClass = "tradingServerMetrics";

export const useServerMetricsCss = () =>
  useComponentCssInjection({
    testId: "trading-server-metrics",
    css: serverMetricsCss,
    window: useWindow(),
  });

/** A metric to chart: a metrics row, a process value or a table's writes. */
export interface SelectedMetric {
  /** metricsHistory.metric: `component.name`, `process.<column>` or `table.<MODULE.table>`. */
  id: string;
  kind: "counter" | "gauge" | "timer";
  unit: string;
}

/** Compact number for cards and tooltips: 1,234 / 12.3 / 0.042. */
export const formatMetric = (value: number) =>
  !Number.isFinite(value)
    ? ""
    : Math.abs(value) >= 100
      ? Math.round(value).toLocaleString("en-US")
      : Math.abs(value) >= 1
        ? value.toFixed(1)
        : value.toFixed(3);
