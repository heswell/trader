import { OrderBlotter } from "@heswell/trading-ui";
import {
  FeatureFrame,
  fillStyle,
  useEntitlements,
  withFeatureRoot,
} from "./shared";

const Orders = () => {
  const { canTrade } = useEntitlements();
  return (
    <FeatureFrame>
      <OrderBlotter
        defaultLinkGroup="red"
        id="orders"
        readOnly={!canTrade}
        showLinkGroupSelector
        style={fillStyle}
      />
    </FeatureFrame>
  );
};

export default withFeatureRoot(Orders, "TradingOrders");
