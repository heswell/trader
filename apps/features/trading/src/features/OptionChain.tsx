import {
  ACTIVE_LINK_GROUP,
  OptionChain as OptionChainView,
} from "@heswell/trading-ui";
import {
  FeatureFrame,
  fillStyle,
  type PickerFeatureProps,
  ToolbarPicker,
  useEntitlements,
  useFeatureLinkGroup,
  withFeatureRoot,
} from "./shared";

/**
 * The option chain of the linked instrument (a stock or index, or the
 * underlying of a linked option or future). A liquid strike's bid / ask
 * opens the ticket (traders only). The simulator lists options on the
 * underlyings in `exchangeSim.options`.
 */
const OptionChain = ({
  defaultLinkGroup = ACTIVE_LINK_GROUP,
  showInstrumentPicker = true,
}: PickerFeatureProps) => {
  const { canTrade } = useEntitlements();
  const { followsActive, linkGroup, setLinkGroup } = useFeatureLinkGroup(
    "OptionChain:option-chain",
    defaultLinkGroup,
  );
  return (
    <FeatureFrame
      toolbar={
        showInstrumentPicker && !followsActive ? (
          <ToolbarPicker id="option-chain-picker" linkGroup={linkGroup} />
        ) : undefined
      }
    >
      <OptionChainView
        id="option-chain"
        launchOrderTicket={canTrade}
        linkGroup={linkGroup}
        onLinkGroupChange={setLinkGroup}
        showLinkGroupSelector
        style={fillStyle}
      />
    </FeatureFrame>
  );
};

export default withFeatureRoot(OptionChain, "TradingOptionChain");
