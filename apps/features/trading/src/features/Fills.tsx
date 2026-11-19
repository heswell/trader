import { FillsBlotter } from "@heswell/trading-ui";
import { FeatureFrame, fillStyle, withFeatureRoot } from "./shared";

const Fills = () => (
  <FeatureFrame>
    <FillsBlotter id="fills" style={fillStyle} />
  </FeatureFrame>
);

export default withFeatureRoot(Fills, "TradingFills");
