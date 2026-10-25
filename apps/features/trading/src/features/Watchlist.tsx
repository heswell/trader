import { InstrumentGrid } from "@heswell/trading-ui";
import {
  FeatureFrame,
  fillStyle,
  useEntitlements,
  withFeatureRoot,
  type LinkedFeatureProps,
} from "./shared";

/** Instrument grid with sparklines; Buy / Sell open the ticket (traders only). */
const Watchlist = ({ defaultLinkGroup = "red" }: LinkedFeatureProps) => {
  const { canTrade } = useEntitlements();
  return (
    <FeatureFrame>
      <InstrumentGrid
        defaultLinkGroup={defaultLinkGroup}
        id="watchlist"
        launchOrderTicket={canTrade}
        showLinkGroupSelector
        style={fillStyle}
      />
    </FeatureFrame>
  );
};

export default withFeatureRoot(Watchlist, "TradingWatchlist");
