import { PositionsView } from "@heswell/trading-ui";
import { FeatureFrame, fillStyle, withFeatureRoot } from "./shared";

const Positions = () => (
  <FeatureFrame>
    <PositionsView
      defaultLinkGroup="green"
      id="positions"
      showLinkGroupSelector
      style={fillStyle}
    />
  </FeatureFrame>
);

export default withFeatureRoot(Positions, "TradingPositions");
