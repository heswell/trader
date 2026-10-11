import { useComponentCssInjection } from "@salt-ds/styles";
import { useWindow } from "@salt-ds/window";
import cx from "clsx";
import { forwardRef, type HTMLAttributes } from "react";
import {
  type StaleIndicatorOptions,
  type StaleReason,
  useStaleIndicator,
} from "../../connection/useStaleIndicator";

import staleIndicatorCss from "./StaleIndicator.css";

const classBase = "tradingStaleIndicator";

export interface StaleIndicatorProps
  extends HTMLAttributes<HTMLSpanElement>,
    StaleIndicatorOptions {
  /** Show stale with this reason instead of observing (tests, showcase). */
  reason?: StaleReason;
}

const LABEL: Record<StaleReason, string> = {
  disconnected: "Stale: disconnected",
  reconnecting: "Stale: reconnecting",
  noUpdates: "Stale: no updates",
};

/**
 * A small "stale" badge for a component's data (see useStaleIndicator).
 * Renders nothing while the data is live.
 */
export const StaleIndicator = forwardRef<HTMLSpanElement, StaleIndicatorProps>(
  function StaleIndicator(
    {
      className,
      connectionId,
      lastUpdate,
      reason: reasonProp,
      staleAfterMs,
      ...htmlAttributes
    },
    ref,
  ) {
    const targetWindow = useWindow();
    useComponentCssInjection({
      testId: "trading-stale-indicator",
      css: staleIndicatorCss,
      window: targetWindow,
    });
    const observed = useStaleIndicator({
      connectionId,
      lastUpdate,
      staleAfterMs,
    });
    const reason = reasonProp ?? (observed.stale ? observed.reason : undefined);
    if (!reason) return null;
    return (
      // biome-ignore lint/a11y/useSemanticElements: inline status badge
      <span
        {...htmlAttributes}
        className={cx(classBase, className, `${classBase}-${reason}`)}
        data-stale-reason={reason}
        ref={ref}
        role="status"
      >
        {LABEL[reason]}
      </span>
    );
  },
);
