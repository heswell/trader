import {
  DEFAULT_LINK_GROUPS,
  FillsBlotter,
  LinkedInstrumentsFooter,
  OrderBlotter,
  OrderBookView,
  PositionsView,
  TradeTape,
} from "@heswell/trading-ui";
import { useState } from "react";

const fill = { height: "100%", minHeight: 0 } as const;

export const OrderBlotterExample = () => <OrderBlotter style={fill} />;

/**
 * The selected order's book beside the blotter: L2 depth with the order's
 * levels marked, and its place in the L3 queue. (In the portal the blotter's
 * Order book button opens the same view in the shell's context panel.)
 */
export const OrderBookViewExample = () => {
  const [orderId, setOrderId] = useState<string>();
  return (
    <div style={{ display: "flex", gap: 16, ...fill }}>
      <div style={{ flex: 2, minHeight: 0, minWidth: 0 }}>
        <OrderBlotter
          onOrderSelect={setOrderId}
          showOrderBook={false}
          style={fill}
        />
      </div>
      <div style={{ flex: 1, minHeight: 0, minWidth: 360, overflow: "auto" }}>
        <OrderBookView orderId={orderId} />
      </div>
    </div>
  );
};

export const FillsBlotterExample = () => {
  const [orderId, setOrderId] = useState<string>();
  return (
    <div style={{ display: "flex", flexDirection: "column", ...fill }}>
      <div>Linked order: {orderId ?? "click an order id"}</div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <FillsBlotter
          defaultGrouping="ric-side"
          highlightOrderId={orderId}
          onOrderSelect={setOrderId}
        />
      </div>
    </div>
  );
};

export const PositionsViewExample = () => (
  <PositionsView defaultGrouping="account" style={fill} />
);

const TAPE_RICS = ["0005.HK", "ADM.L", "AIR.PA", "ROG.S", "TSLA.OQ"];

/** Tape follows the picked ric, or the ric of the order selected in the blotter. */
export const TradeTapeExample = () => {
  const [ric, setRic] = useState(TAPE_RICS[0]);
  const [orderRic, setOrderRic] = useState<string>();
  return (
    <div style={{ display: "flex", gap: 16, ...fill }}>
      <div style={{ flex: 1, minHeight: 0 }}>
        <OrderBlotter
          defaultTab="all"
          onOrderSelect={(_orderId, selected) => setOrderRic(selected)}
          showChildOrders={false}
        />
      </div>
      <div
        style={{
          display: "flex",
          flex: 1,
          flexDirection: "column",
          minHeight: 0,
        }}
      >
        <label>
          Tape for{" "}
          <select onChange={(e) => setRic(e.target.value)} value={ric}>
            {TAPE_RICS.map((r) => (
              <option key={r}>{r}</option>
            ))}
            <option value="">(selected order: {orderRic ?? "none"})</option>
          </select>
        </label>
        <div style={{ flex: 1, minHeight: 0 }}>
          <TradeTape ric={ric || orderRic} />
        </div>
      </div>
    </div>
  );
};

const FOOTER_INSTRUMENTS = [
  { ric: "BARC.L", channel: DEFAULT_LINK_GROUPS[0] },
  { ric: "VOD.L", channel: DEFAULT_LINK_GROUPS[1] },
];

/** The footer on its own: press a chip to filter, press again for all rows. */
export const LinkedInstrumentsFooterExample = () => {
  const [filterRic, setFilterRic] = useState<string>();
  return (
    <div
      style={{ display: "flex", flexDirection: "column", gap: 16, width: 480 }}
    >
      <div>Rows filtered to: {filterRic ?? "all"}</div>
      <LinkedInstrumentsFooter
        activeChannel={DEFAULT_LINK_GROUPS[0].id}
        filterRic={filterRic}
        instruments={FOOTER_INSTRUMENTS}
        onFilterRic={setFilterRic}
        summary={filterRic ? "3 orders" : "12 orders"}
      />
      <LinkedInstrumentsFooter
        activeChannel={DEFAULT_LINK_GROUPS[0].id}
        instruments={[]}
        onFilterRic={() => undefined}
        summary="12 orders"
      />
    </div>
  );
};
