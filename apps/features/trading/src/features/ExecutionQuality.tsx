import {
  AccountSelector,
  SlippageChart,
  useSelectedAccount,
} from "@heswell/trading-ui";
import { FeatureFrame, fillStyle, withFeatureRoot } from "./shared";

/** Portfolio › Execution quality: execution slippage vs arrival for one account. */
const ExecutionQuality = () => {
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
      <SlippageChart account={account} style={fillStyle} />
    </FeatureFrame>
  );
};

export default withFeatureRoot(ExecutionQuality, "TradingExecutionQuality");
