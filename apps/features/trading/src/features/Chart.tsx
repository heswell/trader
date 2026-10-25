import { PriceChart } from "@heswell/trading-ui";
import {
  FeatureFrame,
  fillStyle,
  useAccountToolbar,
  withFeatureRoot,
  type LinkedFeatureProps,
} from "./shared";

/**
 * Candlestick price chart for the linked instrument, with the selected
 * account's fills overlaid.
 */
const Chart = ({ defaultLinkGroup = "red" }: LinkedFeatureProps) => {
  const { account, toolbar } = useAccountToolbar();
  return (
    <FeatureFrame toolbar={toolbar}>
      <PriceChart
        account={account}
        defaultLinkGroup={defaultLinkGroup}
        id="chart"
        showLinkGroupSelector
        style={fillStyle}
      />
    </FeatureFrame>
  );
};

export default withFeatureRoot(Chart, "TradingChart");
