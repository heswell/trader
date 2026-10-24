import {
  AccountSelector,
  PnlHistoryChart,
  useSelectedAccount,
} from "@heswell/trading-ui";
import { FeatureFrame, fillStyle, withFeatureRoot } from "./shared";

/** Portfolio › P&L: P&L history for one account the user can see. */
const Pnl = () => {
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
      <PnlHistoryChart account={account} style={fillStyle} />
    </FeatureFrame>
  );
};

export default withFeatureRoot(Pnl, "TradingPnl");
