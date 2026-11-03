import { ACTIVE_LINK_GROUP, TradeTape } from "@heswell/trading-ui";
import {
  FeatureFrame,
  fillStyle,
  type PickerFeatureProps,
  ToolbarPicker,
  useFeatureLinkGroup,
  withFeatureRoot,
} from "./shared";

const Tape = ({
  defaultLinkGroup = ACTIVE_LINK_GROUP,
  showInstrumentPicker = true,
}: PickerFeatureProps) => {
  const { followsActive, linkGroup, setLinkGroup } = useFeatureLinkGroup(
    "TradeTape:tape",
    defaultLinkGroup,
  );
  return (
    <FeatureFrame
      toolbar={
        showInstrumentPicker && !followsActive ? (
          <ToolbarPicker id="tape-picker" linkGroup={linkGroup} />
        ) : undefined
      }
    >
      <TradeTape
        id="tape"
        linkGroup={linkGroup}
        onLinkGroupChange={setLinkGroup}
        showLinkGroupSelector
        style={fillStyle}
      />
    </FeatureFrame>
  );
};

export default withFeatureRoot(Tape, "TradingTape");
