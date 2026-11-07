import cx from "clsx";
import { forwardRef, type HTMLAttributes, useMemo } from "react";
import { useTradingRows } from "../../data/useTradingRows";
import { Sparkline } from "../Sparkline";
import { formatDuration } from "./formatDuration";
import {
  formatMetric,
  type SelectedMetric,
  useServerMetricsCss,
} from "./useServerMetricsCss";

const classBase = "tradingMetricsProcess";

/** The process values metricsHistory keeps (component "process"). */
export const PROCESS_CARDS = [
  { name: "cpuPct", label: "CPU", unit: "%" },
  { name: "rssMb", label: "RSS", unit: "MB" },
  { name: "heapUsedMb", label: "Heap used", unit: "MB" },
  { name: "loopLagP99Ms", label: "Loop lag p99", unit: "ms" },
  { name: "loopLagMaxMs", label: "Loop lag max", unit: "ms" },
] as const;

const HISTORY_COLUMNS = ["id", "metric", "name", "time", "value"];
const PROCESS_COLUMNS = ["id", "pid", "uptimeS"];
/**
 * Newest first, so the viewport holds the latest samples whatever the
 * server's historySize: 300 per card (5 minutes at 1 s).
 */
const HISTORY_ROWS = PROCESS_CARDS.length * 300;

export interface MetricsProcessStripProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "onSelect"> {
  /** Called with a card's metric when it is clicked (e.g. to chart it). */
  onSelectMetric?: (metric: SelectedMetric) => void;
}

/**
 * The server process at a glance (METRICS, sim-admin only): CPU, memory and
 * event-loop lag, each as its latest value over a sparkline of its
 * metricsHistory (5 minutes by default, so it is filled as soon as it
 * opens).
 */
export const MetricsProcessStrip = forwardRef<
  HTMLDivElement,
  MetricsProcessStripProps
>(function MetricsProcessStrip(
  { className, onSelectMetric, ...htmlAttributes },
  ref,
) {
  useServerMetricsCss();
  const history = useTradingRows("metricsHistory", {
    columns: HISTORY_COLUMNS,
    filter: 'component = "process"',
    rowCount: HISTORY_ROWS,
    sort: { sortDefs: [{ column: "time", sortType: "D" }] },
  });
  const proc = useTradingRows("metricsProcess", {
    columns: PROCESS_COLUMNS,
    rowCount: 1,
  });
  const series = useMemo(() => {
    const byName = new Map<string, number[]>();
    for (const row of history.rows) {
      const name = String(row.name);
      let values = byName.get(name);
      if (!values) {
        values = [];
        byName.set(name, values);
      }
      values.push(Number(row.value));
    }
    for (const values of byName.values()) values.reverse(); // oldest first
    return byName;
  }, [history.rows]);
  const about = proc.rows[0];

  return (
    <div
      {...htmlAttributes}
      className={cx(classBase, className)}
      data-testid="trading-metrics-process"
      ref={ref}
    >
      <div className={`${classBase}-about`}>
        {about
          ? `Process ${about.id} · pid ${about.pid} · up ${formatDuration(Number(about.uptimeS))}`
          : history.loaded && series.size === 0
            ? "No process metrics"
            : "Waiting for metrics"}
      </div>
      <div className={`${classBase}-cards`}>
        {PROCESS_CARDS.map(({ name, label, unit }) => {
          const values = series.get(name) ?? [];
          const last = values.at(-1);
          const metric: SelectedMetric = {
            id: `process.${name}`,
            kind: "gauge",
            unit,
          };
          return (
            <button
              className={`${classBase}-card`}
              data-metric={metric.id}
              key={name}
              onClick={() => onSelectMetric?.(metric)}
              type="button"
            >
              <span className={`${classBase}-label`}>{label}</span>
              <span className={`${classBase}-value`}>
                {last === undefined ? "–" : `${formatMetric(last)} ${unit}`}
              </span>
              <Sparkline
                label={`${label}, last ${values.length} samples`}
                values={values}
              />
            </button>
          );
        })}
      </div>
    </div>
  );
});
