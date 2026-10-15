import { useComponentCssInjection } from "@salt-ds/styles";
import { useWindow } from "@salt-ds/window";
import { useMemo } from "react";
import {
  type StaleIndicatorOptions,
  type StaleIndicatorState,
  type StaleReason,
  useStaleIndicator,
} from "../../connection/useStaleIndicator";

import staleIndicatorCss from "./StaleIndicator.css";

/** Class that greys out an element while it has `data-stale="true"`. */
export const STALE_DATA_CLASS = "tradingStaleData";

export interface StaleDataProps {
  className: string;
  "data-stale"?: "true";
  "data-stale-reason"?: StaleReason;
}

export interface StaleDataState extends StaleIndicatorState {
  /** Spread on the view's data element (merge `className`). */
  staleProps: StaleDataProps;
}

/**
 * useStaleIndicator plus the attributes that grey a ticking view out while
 * its data is stale (disconnected, reconnecting, or no update within
 * `staleAfterMs`). `enabled: false` never marks it stale.
 */
export const useStaleData = ({
  enabled = true,
  ...options
}: StaleIndicatorOptions & { enabled?: boolean } = {}): StaleDataState => {
  const targetWindow = useWindow();
  useComponentCssInjection({
    testId: "trading-stale-indicator",
    css: staleIndicatorCss,
    window: targetWindow,
  });
  const state = useStaleIndicator(options);
  const stale = enabled && state.stale;
  const { reason } = state;
  const staleProps = useMemo<StaleDataProps>(
    () =>
      stale
        ? {
            className: STALE_DATA_CLASS,
            "data-stale": "true",
            "data-stale-reason": reason,
          }
        : { className: STALE_DATA_CLASS },
    [stale, reason],
  );
  return enabled
    ? { ...state, staleProps }
    : { stale: false, connectionState: state.connectionState, staleProps };
};
