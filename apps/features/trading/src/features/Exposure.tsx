import {
  AccountSelector,
  ExposureTreemap,
  useSelectedAccount,
} from "@heswell/trading-ui";
import { FeatureFrame, fillStyle, withFeatureRoot } from "./shared";

/** Portfolio › Exposure: exposure / P&L treemap by sector for one account. */
const Exposure = () => {
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
      <ExposureTreemap account={account} style={fillStyle} />
    </FeatureFrame>
  );
};

export default withFeatureRoot(Exposure, "TradingExposure");
