import { FillsBlotter } from "@heswell/trading-ui";
import { FeatureFrame, fillStyle, withFeatureRoot } from "./shared";

const Fills = () => (
  <FeatureFrame>
    <FillsBlotter
      defaultLinkGroup="red"
      id="fills"
      showLinkGroupSelector
      style={fillStyle}
    />
  </FeatureFrame>
);

export default withFeatureRoot(Fills, "TradingFills");
