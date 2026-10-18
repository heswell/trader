import { DepthChartView } from "@heswell/trading-ui";
import { FeatureFrame, fillStyle, withFeatureRoot } from "./shared";

/** Live cumulative depth chart for the linked instrument. */
const DepthChart = () => (
  <FeatureFrame>
    <DepthChartView
      defaultLinkGroup="red"
      id="depth-chart"
      showLinkGroupSelector
      style={fillStyle}
    />
  </FeatureFrame>
);

export default withFeatureRoot(DepthChart, "TradingDepthChart");
