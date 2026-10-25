import { DepthChartView } from "@heswell/trading-ui";
import {
  FeatureFrame,
  fillStyle,
  withFeatureRoot,
  type LinkedFeatureProps,
} from "./shared";

/** Live cumulative depth chart for the linked instrument. */
const DepthChart = ({ defaultLinkGroup = "red" }: LinkedFeatureProps) => (
  <FeatureFrame>
    <DepthChartView
      defaultLinkGroup={defaultLinkGroup}
      id="depth-chart"
      showLinkGroupSelector
      style={fillStyle}
    />
  </FeatureFrame>
);

export default withFeatureRoot(DepthChart, "TradingDepthChart");
