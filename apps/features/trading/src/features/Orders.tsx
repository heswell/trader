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
        id="orders"
        readOnly={!canTrade}
        style={fillStyle}
        useEditSession
      />
    </FeatureFrame>
  );
};

export default withFeatureRoot(Orders, "TradingOrders");
