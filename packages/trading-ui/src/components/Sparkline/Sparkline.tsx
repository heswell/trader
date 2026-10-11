import { useComponentCssInjection } from "@salt-ds/styles";
import { useWindow } from "@salt-ds/window";
import type {
  RuntimeColumnDescriptor,
  TableCellRendererProps,
} from "@vuu-ui/vuu-table-types";
import { isTypeDescriptor, registerComponent } from "@vuu-ui/vuu-utils";
import cx from "clsx";
import {
  forwardRef,
  memo,
  type SVGAttributes,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";
import {
  type SparklineBuffer,
  recordSample,
  sparklinePoints,
  sparklineStore,
} from "./sparklineBuffer";
import sparklineCss from "./Sparkline.css";

const classBase = "tradingSparkline";

const VIEW_WIDTH = 100;
const VIEW_HEIGHT = 24;

export type SparklineTrend = "up" | "down" | "flat";

const trendOf = (first: number, last: number): SparklineTrend =>
  last > first ? "up" : last < first ? "down" : "flat";

export interface SparklineProps
  extends Omit<SVGAttributes<SVGSVGElement>, "values"> {
  /** Samples, oldest first. */
  values: readonly number[];
  /** Accessible description of the series. Defaults to a summary of the values. */
  label?: string;
}

/**
 * Presentational sparkline (SVG polyline, no axes). Colour follows the trend
 * (up / down / flat) and the trend is also exposed as `data-trend` and in the
 * accessible name, so direction is not conveyed by colour alone.
 */
export const Sparkline = forwardRef<SVGSVGElement, SparklineProps>(
  function Sparkline({ className, label, values, ...svgAttributes }, ref) {
    const targetWindow = useWindow();
    useComponentCssInjection({
      testId: "trading-sparkline",
      css: sparklineCss,
      window: targetWindow,
    });
    const n = values.length;
    let points = "";
    let trend: SparklineTrend = "flat";
    if (n > 1) {
      let min = Number.POSITIVE_INFINITY;
      let max = Number.NEGATIVE_INFINITY;
      for (const v of values) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
      const step = VIEW_WIDTH / (n - 1);
      const range = max - min;
      points = values
        .map(
          (v, i) =>
            `${(i * step).toFixed(1)},${(range === 0 ? VIEW_HEIGHT / 2 : 1 + (VIEW_HEIGHT - 2) - ((v - min) / range) * (VIEW_HEIGHT - 2)).toFixed(1)}`,
        )
        .join(" ");
      trend = trendOf(values[0], values[n - 1]);
    }
    return (
      <svg
        aria-label={label ?? `${n} samples, trend ${trend}`}
        {...svgAttributes}
        className={cx(classBase, className)}
        data-trend={trend}
        preserveAspectRatio="none"
        ref={ref}
        role="img"
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
      >
        <polyline className={`${classBase}-line`} points={points} />
      </svg>
    );
  },
);

export interface SparklineCellOptions {
  /** Column whose value is sampled (default `last`). */
  valueColumn: string;
  /** Ring buffer length (default 40 samples). */
  length: number;
  /** 0 = a sample per change of the value; > 0 = time buckets of this many ms. */
  bucketMs: number;
  /**
   * Skip zero values (default true): a left-joined row has 0 until its first
   * price arrives, which would flatten the chart. Turn off for series that
   * are legitimately 0, e.g. `change`.
   */
  ignoreZero: boolean;
}

export const DEFAULT_SPARKLINE_LENGTH = 40;

export const sparklineOptions = (
  componentProps: Record<string, string | number | boolean> | undefined,
): SparklineCellOptions => ({
  valueColumn:
    typeof componentProps?.valueColumn === "string"
      ? componentProps.valueColumn
      : "last",
  length:
    typeof componentProps?.length === "number" && componentProps.length >= 2
      ? componentProps.length
      : DEFAULT_SPARKLINE_LENGTH,
  bucketMs:
    typeof componentProps?.bucketMs === "number" ? componentProps.bucketMs : 0,
  ignoreZero: componentProps?.ignoreZero !== false,
});

const rendererComponentProps = (column: RuntimeColumnDescriptor) => {
  const renderer = isTypeDescriptor(column.type)
    ? column.type.renderer
    : undefined;
  return renderer && "componentProps" in renderer
    ? renderer.componentProps
    : undefined;
};

const draw = (
  svg: SVGSVGElement | null,
  line: SVGPolylineElement | null,
  buffer: SparklineBuffer,
) => {
  if (!svg || !line) return;
  line.setAttribute("points", sparklinePoints(buffer, VIEW_WIDTH, VIEW_HEIGHT));
  const n = buffer.length;
  const trend = n > 1 ? trendOf(buffer.at(0), buffer.at(n - 1)) : "flat";
  svg.dataset.trend = trend;
  svg.setAttribute("aria-label", `Last ${n} samples, trend ${trend}`);
};

/**
 * Table cell renderer `trading.sparkline`.
 *
 * Keeps a client-side ring buffer per row (see `sparklineStore`), appends the
 * row's `valueColumn` on every change and redraws by updating the polyline
 * directly: no React re-render per tick beyond the Table's own cell update.
 * The buffer is released when the row's cell unmounts or is recycled for
 * another row. History therefore only accumulates while a row is in the
 * viewport, as the server only streams visible rows.
 *
 * Use with a client column (not in the server schema):
 * `{ name: "sparkline", source: "client", sortable: false, type: { name: "string",
 *    renderer: { name: "trading.sparkline", componentProps: { valueColumn: "last", length: 40 } } } }`
 */
export const SparklineCell = memo(
  function SparklineCell({ column, dataRow }: TableCellRendererProps) {
    const targetWindow = useWindow();
    useComponentCssInjection({
      testId: "trading-sparkline",
      css: sparklineCss,
      window: targetWindow,
    });
    const { valueColumn, length, bucketMs, ignoreZero } = sparklineOptions(
      rendererComponentProps(column),
    );
    const rowKey = `${column.name}|${valueColumn}|${dataRow.key}`;
    const raw = dataRow.hasColumn(valueColumn)
      ? dataRow[valueColumn]
      : undefined;
    const value = typeof raw === "string" ? Number(raw) : raw;

    const svgRef = useRef<SVGSVGElement>(null);
    const lineRef = useRef<SVGPolylineElement>(null);
    const bufferRef = useRef<SparklineBuffer | null>(null);

    useLayoutEffect(() => {
      const buffer = sparklineStore.acquire(rowKey, length);
      bufferRef.current = buffer;
      draw(svgRef.current, lineRef.current, buffer);
      return () => {
        sparklineStore.release(rowKey, buffer);
        bufferRef.current = null;
      };
    }, [rowKey, length]);

    // biome-ignore lint/correctness/useExhaustiveDependencies: rowKey: sample the new row's current value after a recycle
    useEffect(() => {
      const buffer = bufferRef.current;
      if (buffer && typeof value === "number" && !(ignoreZero && value === 0)) {
        if (recordSample(buffer, value, { bucketMs })) {
          draw(svgRef.current, lineRef.current, buffer);
        }
      }
    }, [value, bucketMs, ignoreZero, rowKey]);

    return (
      <div className="tradingSparklineCell">
        <svg
          aria-label="No samples"
          className={classBase}
          data-trend="flat"
          preserveAspectRatio="none"
          ref={svgRef}
          role="img"
          viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        >
          <polyline className={`${classBase}-line`} ref={lineRef} />
        </svg>
      </div>
    );
  },
  (prev, next) =>
    prev.column === next.column &&
    prev.dataRow.key === next.dataRow.key &&
    (() => {
      const { valueColumn } = sparklineOptions(
        rendererComponentProps(next.column),
      );
      return (
        !next.dataRow.hasColumn(valueColumn) ||
        prev.dataRow[valueColumn] === next.dataRow[valueColumn]
      );
    })(),
);

let registered = false;

/** Register the `trading.sparkline` cell renderer (idempotent). */
export const registerSparklineRenderer = () => {
  if (registered) return;
  registered = true;
  registerComponent("trading.sparkline", SparklineCell, "cell-renderer", {
    description:
      "Mini line chart of recent values of a column, kept in a client-side ring buffer per row",
    label: "Sparkline",
    serverDataType: ["long", "int", "double", "string"],
  });
};

registerSparklineRenderer();
