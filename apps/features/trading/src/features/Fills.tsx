import { FillsBlotter } from "@heswell/trading-ui";
import {
  FeatureFrame,
  fillStyle,
  withFeatureRoot,
  type LinkedFeatureProps,
} from "./shared";

const Fills = ({ defaultLinkGroup = "red" }: LinkedFeatureProps) => (
  <FeatureFrame>
    <FillsBlotter
      defaultLinkGroup={defaultLinkGroup}
      id="fills"
      showLinkGroupSelector
      style={fillStyle}
    />
  </FeatureFrame>
);

export default withFeatureRoot(Fills, "TradingFills");
