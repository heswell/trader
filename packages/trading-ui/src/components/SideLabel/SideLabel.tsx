import { Side } from "@heswell/trading-schemas";
import { useComponentCssInjection } from "@salt-ds/styles";
import { useWindow } from "@salt-ds/window";
import cx from "clsx";
import { forwardRef, type HTMLAttributes } from "react";

import sideLabelCss from "./SideLabel.css";

const classBase = "tradingSideLabel";

export interface SideLabelProps extends HTMLAttributes<HTMLSpanElement> {
  side: Side | string | undefined;
  /** Render with an outline. */
  variant?: "text" | "pill";
}

const label = (side: SideLabelProps["side"]) =>
  side === Side.Buy ? "Buy" : side === Side.Sell ? "Sell" : (side ?? "");

/** Order side, coloured with the --trading-buy / --trading-sell tokens. */
export const SideLabel = forwardRef<HTMLSpanElement, SideLabelProps>(
  function SideLabel(
    { className, side, variant = "text", ...htmlAttributes },
    ref,
  ) {
    const targetWindow = useWindow();
    useComponentCssInjection({
      testId: "trading-side-label",
      css: sideLabelCss,
      window: targetWindow,
    });
    return (
      <span
        {...htmlAttributes}
        className={cx(classBase, className, {
          [`${classBase}-buy`]: side === Side.Buy,
          [`${classBase}-sell`]: side === Side.Sell,
          [`${classBase}-pill`]: variant === "pill",
        })}
        data-side={side}
        ref={ref}
      >
        {label(side)}
      </span>
    );
  },
);
