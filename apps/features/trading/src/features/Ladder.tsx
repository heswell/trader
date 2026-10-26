import { PriceLadder } from "@heswell/trading-ui";
import {
  FeatureFrame,
  fillStyle,
  type PickerFeatureProps,
  ToolbarPicker,
  useAccountToolbar,
  withFeatureRoot,
} from "./shared";

/** Click-to-trade price ladder (module gated by trading-execute). */
const Ladder = ({
  defaultLinkGroup = "green",
  showInstrumentPicker = true,
}: PickerFeatureProps) => {
  const { account, toolbar } = useAccountToolbar(
    showInstrumentPicker ? (
      <ToolbarPicker id="ladder-picker" linkGroup={defaultLinkGroup} />
    ) : null,
  );
  return (
    <FeatureFrame toolbar={toolbar}>
      <PriceLadder
        account={account}
        defaultLinkGroup={defaultLinkGroup}
        defaultQuantity={100}
        id="ladder"
        showLinkGroupSelector
        style={fillStyle}
      />
    </FeatureFrame>
  );
};

export default withFeatureRoot(Ladder, "TradingLadder");
