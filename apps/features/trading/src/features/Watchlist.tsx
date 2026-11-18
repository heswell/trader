import { InstrumentGrid } from "@heswell/trading-ui";
import {
  FeatureFrame,
  fillStyle,
  useEntitlements,
  withFeatureRoot,
} from "./shared";

/**
 * Instrument grid with sparklines; Buy / Sell open the ticket (traders
 * only). Rows link to the workspace channels from the grid's link column.
 */
const Watchlist = () => {
  const { canTrade } = useEntitlements();
  return (
    <FeatureFrame flush>
      <InstrumentGrid
        id="watchlist"
        launchOrderTicket={canTrade}
        style={fillStyle}
      />
    </FeatureFrame>
  );
};

export default withFeatureRoot(Watchlist, "TradingWatchlist");
