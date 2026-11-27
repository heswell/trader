import { getTradingTestData } from "@heswell/trading-test-data";
import { LimitBreaches, LimitMonitor } from "@heswell/trading-ui";
import { useEffect } from "react";

const fill = { height: "100%", minHeight: 0, padding: 8 } as const;

/**
 * Desk and firm limits tight enough for the background flow to reach them
 * within a minute or two (local mode only; the trading server has its own
 * in application.trading.conf).
 */
export const DEMO_LIMITS = [
  "FIRM:GROSS_POSITION_NOTIONAL=6000000",
  "FIRM:ORDER_RATE=6",
  "FIRM:DAILY_LOSS=60000",
  "EQ-US:GROSS_POSITION_NOTIONAL=1500000",
  "EQ-EU:GROSS_POSITION_NOTIONAL=1500000",
  "EQ-US:DAILY_LOSS=25000",
  "ACC-US-01:ORDER_NOTIONAL=30000",
  "ACC-EU-01:ORDER_NOTIONAL=30000",
].join(",");

/** Adds DEMO_LIMITS to the local test data once (a no-op when remote). */
const useDemoLimits = () => {
  useEffect(() => {
    try {
      getTradingTestData().omsService.addLimits(DEMO_LIMITS);
    } catch {
      // remote mode: no local data
    }
  }, []);
};

export const LimitMonitorExample = () => {
  useDemoLimits();
  return (
    <div style={fill}>
      <LimitMonitor />
    </div>
  );
};

export const LimitBreachesExample = () => {
  useDemoLimits();
  return (
    <div style={fill}>
      <LimitBreaches defaultStatus="all" />
    </div>
  );
};
