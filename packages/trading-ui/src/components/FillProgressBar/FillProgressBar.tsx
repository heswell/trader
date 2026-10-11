import { useComponentCssInjection } from "@salt-ds/styles";
import { useWindow } from "@salt-ds/window";
import cx from "clsx";
import { type CSSProperties, forwardRef, type HTMLAttributes } from "react";
import { formatQuantity } from "../../utils/formatting";
import fillProgressBarCss from "./FillProgressBar.css";

const classBase = "tradingFillProgressBar";

export interface FillProgressBarProps extends HTMLAttributes<HTMLDivElement> {
  /** Filled quantity (cumQty). */
  filled: number | undefined;
  /** Order quantity. */
  total: number | undefined;
  /** Terminal but unfilled orders (cancelled / rejected) render muted. */
  muted?: boolean;
}

/**
 * Fill progress as a bar plus `filled / total` text. `role="progressbar"`
 * with value text, so it is not conveyed by the bar alone.
 */
export const FillProgressBar = forwardRef<HTMLDivElement, FillProgressBarProps>(
  function FillProgressBar(
    { className, filled, muted, total, ...htmlAttributes },
    ref,
  ) {
    const targetWindow = useWindow();
    useComponentCssInjection({
      testId: "trading-fill-progress-bar",
      css: fillProgressBarCss,
      window: targetWindow,
    });
    const hasValues =
      typeof filled === "number" && typeof total === "number" && total > 0;
    const pct = hasValues
      ? Math.min(100, Math.max(0, (filled / total) * 100))
      : 0;
    const text = hasValues
      ? `${formatQuantity(filled)} / ${formatQuantity(total)}`
      : "";
    return (
      <div
        {...htmlAttributes}
        aria-label="Filled"
        aria-valuemax={hasValues ? total : undefined}
        aria-valuemin={0}
        aria-valuenow={hasValues ? filled : undefined}
        aria-valuetext={text ? `${text} (${Math.round(pct)}%)` : undefined}
        className={cx(classBase, className, {
          [`${classBase}-complete`]: pct >= 100,
          [`${classBase}-muted`]: muted,
        })}
        data-pct={Math.round(pct)}
        ref={ref}
        role="progressbar"
        style={{ "--tradingFillProgressBar-pct": `${pct}%` } as CSSProperties}
      >
        <span aria-hidden="true" className={`${classBase}-bar`} />
        <span className={`${classBase}-text`}>{text}</span>
      </div>
    );
  },
);
