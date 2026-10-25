import { OrderBlotter } from "@heswell/trading-ui";
import {
  FeatureFrame,
  fillStyle,
  useEntitlements,
  withFeatureRoot,
  type LinkedFeatureProps,
} from "./shared";

const Orders = ({ defaultLinkGroup = "red" }: LinkedFeatureProps) => {
  const { canTrade } = useEntitlements();
  return (
    <FeatureFrame>
      <OrderBlotter
        defaultLinkGroup={defaultLinkGroup}
        id="orders"
        readOnly={!canTrade}
        showLinkGroupSelector
        style={fillStyle}
        useEditSession
      />
    </FeatureFrame>
  );
};

export default withFeatureRoot(Orders, "TradingOrders");
