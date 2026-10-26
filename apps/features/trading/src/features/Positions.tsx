import { PositionsView } from "@heswell/trading-ui";
import {
  FeatureFrame,
  fillStyle,
  withFeatureRoot,
  type LinkedFeatureProps,
} from "./shared";

const Positions = ({ defaultLinkGroup = "green" }: LinkedFeatureProps) => (
  <FeatureFrame>
    <PositionsView
      defaultLinkGroup={defaultLinkGroup}
      id="positions"
      showLinkGroupSelector
      style={fillStyle}
    />
  </FeatureFrame>
);

export default withFeatureRoot(Positions, "TradingPositions");
