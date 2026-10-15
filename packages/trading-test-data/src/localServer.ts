import {
  createTradingTestData,
  type TradingTestData,
  type TradingTestDataOptions,
} from "./createTradingTestData";

/** connectionId used by the showcase / local mode for the trading server. */
export const TRADING_LOCAL_CONNECTION_ID = "trading";

let instance: TradingTestData | undefined;

/**
 * The shared in-browser trading data (created on first use). Options only
 * apply to the call that creates it; use resetTradingTestData to recreate.
 */
export const getTradingTestData = (options?: TradingTestDataOptions) => {
  instance ??= createTradingTestData(options);
  return instance;
};

/**
 * Disposes the shared in-browser trading data and recreates it with `options`
 * (tests, showcase reset).
 */
export const resetTradingTestData = (options?: TradingTestDataOptions) => {
  instance?.dispose();
  instance = createTradingTestData(options);
  return instance;
};
