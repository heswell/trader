import { MarketDepth } from "@heswell/trading-ui";
import {
  FeatureFrame,
  fillStyle,
  useAccountToolbar,
  withFeatureRoot,
  type LinkedFeatureProps,
} from "./shared";

/** Market depth for the linked instrument, with the account's own orders. */
const Depth = ({ defaultLinkGroup = "red" }: LinkedFeatureProps) => {
  const { account, toolbar } = useAccountToolbar();
  return (
    <FeatureFrame toolbar={toolbar}>
      <MarketDepth
        account={account}
        defaultLinkGroup={defaultLinkGroup}
        id="depth"
        showLinkGroupSelector
        style={fillStyle}
      />
    </FeatureFrame>
  );
};

export default withFeatureRoot(Depth, "TradingDepth");
