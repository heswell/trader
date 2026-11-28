import { getTradingTestData } from "@heswell/trading-test-data";
import { LimitState, OrdType, Side } from "@heswell/trading-schemas";
import {
  IncreaseRequestDialog,
  KillSwitchDialog,
  LimitBreaches,
  LimitMonitor,
  LimitStateBadge,
  OrderTicket,
  UtilisationBar,
  useTradingDataSource,
} from "@heswell/trading-ui";
import { Button } from "@salt-ds/core";
import { useEffect, useState } from "react";

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

const BARS = [
  { utilisation: 0.42, state: LimitState.Ok },
  { utilisation: 0.88, state: LimitState.Warning },
  { utilisation: 1.04, state: LimitState.SoftBreach },
  { utilisation: 1.22, state: LimitState.HardBreach },
];

export const UtilisationBarExamples = () => (
  <div style={{ display: "grid", gap: 12, padding: 16, width: 320 }}>
    {BARS.map(({ utilisation, state }) => (
      <div
        key={state}
        style={{ alignItems: "center", display: "flex", gap: 12 }}
      >
        <div style={{ flex: 1 }}>
          <UtilisationBar
            hardPct={1.1}
            state={state}
            utilisation={utilisation}
            warningPct={0.8}
          />
        </div>
        <LimitStateBadge state={state} />
      </div>
    ))}
  </div>
);

const DEMO_TARGET = {
  limitKey: "ACC-US-01:ORDER_NOTIONAL",
  entityId: "ACC-US-01",
  metric: "ORDER_NOTIONAL",
  ric: "",
  used: 27_400,
  soft: 30_000,
  hard: 33_000,
};

const DEMO_CHAIN = [
  { entityId: "ACC-US-01", entityType: "ACCOUNT", label: "ACC-US-01" },
  { entityId: "EQ-US", entityType: "DESK", label: "EQ-US" },
  { entityId: "FIRM", entityType: "FIRM", label: "Firm" },
];

/** The two dialogs on their own, on a demo limit (sending is real). */
export const LimitDialogsExample = () => {
  useDemoLimits();
  const dataSource = useTradingDataSource("limitUtilisation");
  const [open, setOpen] = useState<"increase" | "kill">();
  return (
    <div style={{ display: "flex", gap: 8, padding: 16 }}>
      <Button appearance="bordered" onClick={() => setOpen("increase")}>
        Request increase…
      </Button>
      <Button onClick={() => setOpen("kill")} sentiment="negative">
        Kill switch…
      </Button>
      {open === "increase" ? (
        <IncreaseRequestDialog
          approver="sam"
          dataSource={dataSource}
          onClose={() => setOpen(undefined)}
          target={DEMO_TARGET}
        />
      ) : null}
      {open === "kill" ? (
        <KillSwitchDialog
          dataSource={dataSource}
          entities={DEMO_CHAIN}
          onClose={() => setOpen(undefined)}
          workingOrders={(entityId) => (entityId === "FIRM" ? 12 : 3)}
        />
      ) : null}
    </div>
  );
};

/** ACC-US-02's position limit, low enough to reach from the ticket. */
const TICKET_LIMIT = "ACC-US-02:POSITION_NOTIONAL=600000";

const TICKET_PREFILL = {
  ric: "AAPL.OQ",
  account: "ACC-US-02",
  side: Side.Buy,
  ordType: OrdType.Limit,
} as const;

/**
 * The order ticket's limit check on ACC-US-02 (position limit 600k USD,
 * hard 660k): a quantity worth 80% of it warns, over 600k needs an override
 * reason, over 660k is blocked.
 */
export const LimitTicketExample = () => {
  useEffect(() => {
    try {
      getTradingTestData().omsService.addLimits(TICKET_LIMIT);
    } catch {
      // remote mode: no local data
    }
  }, []);
  return (
    <div style={{ padding: 16, width: 380 }}>
      <OrderTicket prefill={TICKET_PREFILL} rememberAccount={false} />
    </div>
  );
};
