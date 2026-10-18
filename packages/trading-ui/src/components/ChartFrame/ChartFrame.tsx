import { useComponentCssInjection } from "@salt-ds/styles";
import { useWindow } from "@salt-ds/window";
import type { EChartsOption } from "@vuu-ui/vuu-chart";
import cx from "clsx";
import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import chartFrameCss from "./ChartFrame.css";

const classBase = "tradingChartFrame";

/**
 * `echartsOptions` override for every trading chart: vuu-chart turns off the
 * global `animation`, but echarts series default to `animation: true`, which
 * wins. Live data then restarts each series' update transition on every tick
 * (a treemap never settles; lines burn CPU). See trader upstream issue 95.
 */
export const disableSeriesAnimation = (option: EChartsOption): EChartsOption =>
  Array.isArray(option.series)
    ? {
        ...option,
        series: option.series.map((series: EChartsOption) => ({
          ...series,
          animation: false,
        })),
      }
    : option;

export interface ChartFrameProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  /** Toolbar content (title, selectors); no toolbar when omitted. */
  toolbar?: ReactNode;
  /** Shown instead of the chart, e.g. "Select an instrument". */
  message?: ReactNode;
}

/**
 * Internal layout shared by the trading chart components: optional toolbar,
 * a body that the vuu-chart fills, or a centred message. Maps the
 * `--trading-up` / `--trading-down` tokens onto vuu-chart's theme.
 */
export const ChartFrame = forwardRef<HTMLDivElement, ChartFrameProps>(
  function ChartFrame(
    { children, className, message, toolbar, ...htmlAttributes },
    ref,
  ) {
    const targetWindow = useWindow();
    useComponentCssInjection({
      testId: "trading-chart-frame",
      css: chartFrameCss,
      window: targetWindow,
    });
    return (
      <div {...htmlAttributes} className={cx(classBase, className)} ref={ref}>
        {toolbar ? (
          <div className={`${classBase}-toolbar`}>{toolbar}</div>
        ) : null}
        <div className={`${classBase}-body`}>
          {message ? (
            <output className={`${classBase}-message`}>{message}</output>
          ) : (
            children
          )}
        </div>
      </div>
    );
  },
);

export const chartFrameClass = classBase;
