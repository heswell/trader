import {
  FillsBlotter,
  OrderBlotter,
  OrderBookView,
  PositionsView,
  TradeTape,
  useSelectedInstrument,
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

/** Tape follows the picked ric, or the instrument selected in the blotter. */
export const TradeTapeExample = () => {
  const { selectedInstrument } = useSelectedInstrument();
  const [ric, setRic] = useState(TAPE_RICS[0]);
  return (
    <div style={{ display: "flex", gap: 16, ...fill }}>
      <div style={{ flex: 1, minHeight: 0 }}>
        <OrderBlotter defaultTab="all" showChildOrders={false} />
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
            <option value="">
              (selected: {selectedInstrument?.ric ?? "none"})
            </option>
          </select>
        </label>
        <div style={{ flex: 1, minHeight: 0 }}>
          <TradeTape ric={ric || undefined} />
        </div>
      </div>
    </div>
  );
};
