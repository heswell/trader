/**
 * React / DOM bindings (`@heswell/trading-test-data/react`). Kept out of the
 * main entry because engine-local's `/react` entry imports `@vuu-ui/core`,
 * which needs a DOM at import time; the main entry runs in plain Bun/Node.
 */
import { createLocalVuuServer } from "@heswell/vuu-data-engine-local/react";
import type { LocalVuuServer } from "@vuu-ui/core";
import type { TradingTestData } from "./createTradingTestData";
import { getTradingTestData, TRADING_LOCAL_CONNECTION_ID } from "./localServer";

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
    engine: testData.engine,
  });
