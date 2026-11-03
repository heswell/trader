import { PriceLadder } from "@heswell/trading-ui";
import {
  FeatureFrame,
  fillStyle,
  type PickerFeatureProps,
  ToolbarPicker,
  useAccountToolbar,
  useFeatureLinkGroup,
  withFeatureRoot,
} from "./shared";

/** Click-to-trade price ladder (module gated by trading-execute). */
const Ladder = ({
  defaultLinkGroup = "green",
  showInstrumentPicker = true,
}: PickerFeatureProps) => {
  const { followsActive, linkGroup, setLinkGroup } = useFeatureLinkGroup(
    "PriceLadder:ladder",
    defaultLinkGroup,
  );
  const { account, toolbar } = useAccountToolbar(
    showInstrumentPicker && !followsActive ? (
      <ToolbarPicker id="ladder-picker" linkGroup={linkGroup} />
    ) : null,
  );
  return (
    <FeatureFrame toolbar={toolbar}>
      <PriceLadder
        account={account}
        defaultQuantity={100}
        id="ladder"
        linkGroup={linkGroup}
        onLinkGroupChange={setLinkGroup}
        showLinkGroupSelector
        style={fillStyle}
      />
    </FeatureFrame>
  );
};

export default withFeatureRoot(Ladder, "TradingLadder");
