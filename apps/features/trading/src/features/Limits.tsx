import { BreachStatus, LimitRequestStatus } from "@heswell/trading-schemas";
import {
  LimitBreaches,
  LimitMonitor,
  useTradingRows,
} from "@heswell/trading-ui";
import { ToggleButton, ToggleButtonGroup } from "@salt-ds/core";
import { type SyntheticEvent, useState } from "react";
import { FeatureFrame, fillStyle, withFeatureRoot } from "./shared";

type LimitsView = "monitor" | "breaches";

/** Open breaches and pending increase requests, for the Breaches tab badge. */
const useBreachCount = () => {
  const open = useTradingRows("limitBreaches", {
    columns: ["breachId", "status"],
    filter: `status = "${BreachStatus.Open}"`,
    rowCount: 1_000,
  });
  const requests = useTradingRows("limitRequests", {
    columns: ["requestId", "status"],
    filter: `status = "${LimitRequestStatus.Pending}"`,
    rowCount: 1_000,
  });
  return open.rows.length + requests.rows.length;
};

/**
 * Oversight › Limits: the limit monitor (live utilisation by desk and
 * account, contributors, kill switch) and the breaches blotter
 * (acknowledge, escalate, temporary increases). Traders see their own
 * accounts' limits and those of their desk and the Firm; a supervisor sees
 * every desk's and approves increases.
 */
const Limits = () => {
  const [view, setView] = useState<LimitsView>("monitor");
  const breaches = useBreachCount();
  return (
    <FeatureFrame
      toolbar={
        <ToggleButtonGroup
          aria-label="Limits view"
          onChange={(e: SyntheticEvent<HTMLButtonElement>) =>
            setView(e.currentTarget.value as LimitsView)
          }
          value={view}
        >
          <ToggleButton value="monitor">Limit monitor</ToggleButton>
          <ToggleButton value="breaches">
            Breaches{breaches > 0 ? ` ${breaches}` : ""}
          </ToggleButton>
        </ToggleButtonGroup>
      }
    >
      {view === "monitor" ? (
        <LimitMonitor id="limits-monitor" style={fillStyle} />
      ) : (
        <LimitBreaches id="limits-breaches" style={fillStyle} />
      )}
    </FeatureFrame>
  );
};

export default withFeatureRoot(Limits, "TradingLimits");
