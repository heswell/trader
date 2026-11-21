import { ACTIVE_LINK_GROUP, TradesView } from "@heswell/trading-ui";
import {
  FeatureFrame,
  fillStyle,
  type PickerFeatureProps,
  ToolbarPicker,
  useFeatureLinkGroup,
  withFeatureRoot,
} from "./shared";

const Trades = ({
  defaultLinkGroup = ACTIVE_LINK_GROUP,
  showInstrumentPicker = true,
}: PickerFeatureProps) => {
  const { followsActive, linkGroup, setLinkGroup } = useFeatureLinkGroup(
    "TradesView:trades",
    defaultLinkGroup,
  );
  return (
    <FeatureFrame
      toolbar={
        showInstrumentPicker && !followsActive ? (
          <ToolbarPicker id="trades-picker" linkGroup={linkGroup} />
        ) : undefined
      }
    >
      <TradesView
        id="trades"
        linkGroup={linkGroup}
        onLinkGroupChange={setLinkGroup}
        showLinkGroupSelector
        style={fillStyle}
      />
    </FeatureFrame>
  );
};

export default withFeatureRoot(Trades, "TradingTrades");
