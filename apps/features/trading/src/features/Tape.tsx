import { TradeTape } from "@heswell/trading-ui";
import { FeatureFrame, fillStyle, withFeatureRoot } from "./shared";

const Tape = () => (
  <FeatureFrame>
    <TradeTape
      defaultLinkGroup="green"
      id="tape"
      showLinkGroupSelector
      style={fillStyle}
    />
  </FeatureFrame>
);

export default withFeatureRoot(Tape, "TradingTape");
