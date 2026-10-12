import { OrderTicketPanel } from "@heswell/trading-ui";
import { FeatureFrame, fillStyle, withFeatureRoot } from "./shared";

/**
 * Docked order ticket (module gated by trading-execute). It follows its
 * link group and is the launch target for Buy / Sell in the same window's
 * feature root (the Trader workspace).
 */
const Ticket = () => (
  <FeatureFrame>
    <OrderTicketPanel
      defaultLinkGroup="red"
      id="ticket"
      showLinkGroupSelector
      style={fillStyle}
    />
  </FeatureFrame>
);

export default withFeatureRoot(Ticket, "TradingTicket");
