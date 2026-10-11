import { createLocalVuuServer } from "@heswell/vuu-data-engine-local";
import type { LocalVuuServer } from "@vuu-ui/core";
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

export const resetTradingTestData = (options?: TradingTestDataOptions) => {
  instance?.dispose();
  instance = createTradingTestData(options);
  return instance;
};

/**
 * A LocalVuuServer publishing the EXCHANGE and OMS modules: pass it to a
 * local-mode AuthenticationProvider (`localServers`) or render its
 * DataSourceProvider directly (as TradingDataProvider mode="local" does).
 */
export const createTradingLocalServer = (
  testData: TradingTestData = getTradingTestData(),
  connectionId = TRADING_LOCAL_CONNECTION_ID,
): LocalVuuServer =>
  createLocalVuuServer({
    connectionId,
    modules: [testData.exchange, testData.oms],
  });
