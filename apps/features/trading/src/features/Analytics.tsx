import {
  AccountSelector,
  ExposureTreemap,
  PnlHistoryChart,
  SlippageChart,
  useSelectedAccount,
} from "@heswell/trading-ui";
import type { CSSProperties } from "react";
import { FeatureFrame, fillStyle, withFeatureRoot } from "./shared";

const grid: CSSProperties = {
  ...fillStyle,
  display: "grid",
  gap: 4,
  gridTemplateColumns: "1fr 1fr",
  gridTemplateRows: "1fr 1fr",
};
const wide: CSSProperties = { gridColumn: "1 / span 2", minHeight: 0 };
const cell: CSSProperties = { minHeight: 0 };

/**
 * Account analytics: P&L history, exposure / P&L treemap by sector and
 * execution slippage, for one account the user can see.
 */
const Analytics = () => {
  const [account, setAccount, accounts] = useSelectedAccount();
  return (
    <FeatureFrame
      toolbar={
        <AccountSelector
          accounts={accounts}
          onChange={setAccount}
          value={account}
        />
      }
    >
      <div style={grid}>
        <PnlHistoryChart account={account} style={wide} />
        <ExposureTreemap account={account} style={cell} />
        <SlippageChart account={account} style={cell} />
      </div>
    </FeatureFrame>
  );
};

export default withFeatureRoot(Analytics, "TradingAnalytics");
