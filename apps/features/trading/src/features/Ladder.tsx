import { PriceLadder } from "@heswell/trading-ui";
import {
  FeatureFrame,
  fillStyle,
  useAccountToolbar,
  withFeatureRoot,
} from "./shared";

/** Click-to-trade price ladder (module gated by trading-execute). */
const Ladder = () => {
  const { account, toolbar } = useAccountToolbar();
  return (
    <FeatureFrame toolbar={toolbar}>
      <PriceLadder
        account={account}
        defaultLinkGroup="green"
        defaultQuantity={100}
        id="ladder"
        showLinkGroupSelector
        style={fillStyle}
      />
    </FeatureFrame>
  );
};

export default withFeatureRoot(Ladder, "TradingLadder");
