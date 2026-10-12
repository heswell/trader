import { MarketDepth } from "@heswell/trading-ui";
import {
  FeatureFrame,
  fillStyle,
  useAccountToolbar,
  withFeatureRoot,
} from "./shared";

/** Market depth for the linked instrument, with the account's own orders. */
const Depth = () => {
  const { account, toolbar } = useAccountToolbar();
  return (
    <FeatureFrame toolbar={toolbar}>
      <MarketDepth
        account={account}
        defaultLinkGroup="red"
        id="depth"
        showLinkGroupSelector
        style={fillStyle}
      />
    </FeatureFrame>
  );
};

export default withFeatureRoot(Depth, "TradingDepth");
