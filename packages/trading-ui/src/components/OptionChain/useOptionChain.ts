import { InstrumentType } from "@heswell/trading-schemas";
import { useMemo } from "react";
import { useTradingRows } from "../../data/useTradingRows";
import {
  buildOptionChain,
  CHAIN_ANALYTICS_COLUMNS,
  CHAIN_INSTRUMENT_COLUMNS,
  type OptionChainData,
  underlyingFilter,
} from "./optionChainModel";

/** More than a chain lists (84 options per underlying at the defaults). */
const MAX_OPTIONS = 1_000;

export interface OptionChainState {
  chain: OptionChainData;
  /** True once the options (not yet the analytics) have loaded. */
  loaded: boolean;
}

/**
 * The listed options on `underlying` (a ric, or its root: AAPL finds
 * AAPL.OQ) with their quotes from instrumentPrices and implied vol and
 * delta from optionAnalytics. Subscribed only while `enabled` and there is
 * an underlying.
 */
export const useOptionChain = (
  underlying: string | undefined,
  { enabled = true }: { enabled?: boolean } = {},
): OptionChainState => {
  const match = underlyingFilter(underlying);
  const on = enabled && match !== undefined;
  const options = useTradingRows("instrumentPrices", {
    columns: CHAIN_INSTRUMENT_COLUMNS,
    enabled: on,
    filter: on
      ? `instrumentType = "${InstrumentType.Option}" and ${match}`
      : undefined,
    rowCount: MAX_OPTIONS,
  });
  const analytics = useTradingRows("optionAnalytics", {
    columns: CHAIN_ANALYTICS_COLUMNS,
    enabled: on,
    filter: on ? match : undefined,
    rowCount: MAX_OPTIONS,
  });
  const chain = useMemo(
    () => buildOptionChain(options.rows, analytics.rows),
    [options.rows, analytics.rows],
  );
  return { chain, loaded: on && options.loaded };
};
