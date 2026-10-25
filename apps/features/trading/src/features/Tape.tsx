import { TradeTape } from "@heswell/trading-ui";
import {
  FeatureFrame,
  fillStyle,
  type PickerFeatureProps,
  ToolbarPicker,
  withFeatureRoot,
} from "./shared";

const Tape = ({
  defaultLinkGroup = "green",
  showInstrumentPicker = false,
}: PickerFeatureProps) => (
  <FeatureFrame
    toolbar={
      showInstrumentPicker ? (
        <ToolbarPicker id="tape-picker" linkGroup={defaultLinkGroup} />
      ) : undefined
    }
  >
    <TradeTape
      defaultLinkGroup={defaultLinkGroup}
      id="tape"
      showLinkGroupSelector
      style={fillStyle}
    />
  </FeatureFrame>
);

export default withFeatureRoot(Tape, "TradingTape");
