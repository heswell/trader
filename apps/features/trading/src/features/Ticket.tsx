import { OrderTicketPanel } from "@heswell/trading-ui";
import {
  FeatureFrame,
  fillStyle,
  withFeatureRoot,
  type LinkedFeatureProps,
} from "./shared";

/**
 * Docked order ticket (module gated by trading-execute). It follows its
 * link group and is the launch target for Buy / Sell anywhere in the window
 * (e.g. the Watchlist panel of a workspace).
 */
const Ticket = ({ defaultLinkGroup = "red" }: LinkedFeatureProps) => (
  <FeatureFrame>
    <OrderTicketPanel
      defaultLinkGroup={defaultLinkGroup}
      id="ticket"
      showLinkGroupSelector
      style={fillStyle}
    />
  </FeatureFrame>
);

export default withFeatureRoot(Ticket, "TradingTicket");
