import { InstrumentGrid } from "@heswell/trading-ui";
import {
  FeatureFrame,
  fillStyle,
  useEntitlements,
  withFeatureRoot,
} from "./shared";

/** Instrument grid with sparklines; Buy / Sell open the ticket (traders only). */
const Watchlist = () => {
  const { canTrade } = useEntitlements();
  return (
    <FeatureFrame>
      <InstrumentGrid
        defaultLinkGroup="red"
        id="watchlist"
        launchOrderTicket={canTrade}
        showLinkGroupSelector
        style={fillStyle}
      />
    </FeatureFrame>
  );
};

export default withFeatureRoot(Watchlist, "TradingWatchlist");
