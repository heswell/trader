import { useComponentCssInjection } from "@salt-ds/styles";
import { useWindow } from "@salt-ds/window";
import cx from "clsx";
import { forwardRef, type HTMLAttributes } from "react";
import { formatNotional } from "../../utils/formatting";
import pnlValueCss from "./PnlValue.css";

const classBase = "tradingPnlValue";

export interface PnlValueProps extends HTMLAttributes<HTMLSpanElement> {
  value: number | undefined | null;
  /** ISO code shown after the amount (GBX amounts are pence). */
  currency?: string;
  /** Hide the direction arrow (the explicit +/- sign always remains). */
  hideArrow?: boolean;
}

/**
 * A signed P&L / change amount: explicit +/- sign, up/down arrow and colour
 * (`directionColour` tokens), so direction is never colour only.
 * `data-direction` is "up" | "down" | "flat".
 */
export const PnlValue = forwardRef<HTMLSpanElement, PnlValueProps>(
  function PnlValue(
    { className, currency, hideArrow, value, ...htmlAttributes },
    ref,
  ) {
    const targetWindow = useWindow();
    useComponentCssInjection({
      testId: "trading-pnl-value",
      css: pnlValueCss,
      window: targetWindow,
    });
    if (typeof value !== "number") {
      return (
        <span
          {...htmlAttributes}
          className={cx(classBase, className)}
          ref={ref}
        />
      );
    }
    const direction = value > 0 ? "up" : value < 0 ? "down" : "flat";
    return (
      <span
        {...htmlAttributes}
        className={cx(classBase, `${classBase}-${direction}`, className)}
        data-direction={direction}
        ref={ref}
      >
        {hideArrow ? null : (
          <span aria-hidden="true" className={`${classBase}-arrow`}>
            {direction === "up" ? "▲" : direction === "down" ? "▼" : "▬"}
          </span>
        )}
        {formatNotional(value, { currency, signed: true })}
      </span>
    );
  },
);
