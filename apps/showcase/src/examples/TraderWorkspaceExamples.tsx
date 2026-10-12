import {
  FillsBlotter,
  InstrumentGrid,
  InstrumentPicker,
  MarketDepth,
  OrderBlotter,
  OrderTicketPanel,
  PositionsView,
  PriceLadder,
  TradeTape,
} from "@heswell/trading-ui";
import { Button } from "@salt-ds/core";
import {
  FlexboxLayout,
  LayoutProvider,
  setPersistentState,
  StackLayout,
  View,
} from "@vuu-ui/vuu-layout";
import { type CSSProperties, useCallback, useState } from "react";

/** Stable View ids: they key the persisted View state in the saved layout. */
const ID = {
  root: "tw-root",
  left: "tw-left",
  grid: "tw-grid",
  blotters: "tw-blotters",
  orders: "tw-orders",
  fills: "tw-fills",
  positions: "tw-positions",
  middle: "tw-middle",
  ticket: "tw-ticket",
  depth: "tw-depth",
  right: "tw-right",
  ladder: "tw-ladder",
  tape: "tw-tape",
  gridTable: "tw-grid-table",
} as const;

const ACCOUNT = "ACC-US-01";
const LAYOUT_STORAGE_KEY = "trading-showcase.trader-workspace.layout";

/** The parts of vuu-layout's serialized layout used here. */
interface SavedLayoutNode {
  id?: string;
  state?: unknown;
  children?: SavedLayoutNode[];
}

const fill: CSSProperties = { flexBasis: 0, flexGrow: 1, flexShrink: 1 };
const content: CSSProperties = { height: "100%", minHeight: 0 };

/**
 * Restore the per-View saved state (where each component keeps its link
 * group) of the last saved layout, as LayoutProvider does for a layout
 * loaded from JSON. Views must have stable ids.
 */
const restoreViewState = () => {
  let json: SavedLayoutNode | undefined;
  try {
    json = JSON.parse(localStorage.getItem(LAYOUT_STORAGE_KEY) ?? "null");
  } catch {
    json = undefined;
  }
  const visit = (node: SavedLayoutNode | undefined) => {
    if (!node) return;
    if (node.id && node.state) setPersistentState(node.id, node.state);
    node.children?.forEach(visit);
  };
  visit(json);
};

/**
 * A trader workspace in a vuu-layout: two link groups. Red follows the
 * instrument grid (ticket, depth, blotters); green follows the picker and
 * positions (ladder, tape). Every View has a link group selector: move a
 * component to the other group (or unlink it) and the choice is saved with
 * the layout (reload the page to see it restored). Buy / Sell in the grid
 * opens the docked ticket; order toasts come from the notifications provider.
 */
export const TraderWorkspace = () => {
  useState(restoreViewState);
  const handleLayoutChange = useCallback((layout: object) => {
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout));
  }, []);
  const reset = () => {
    localStorage.removeItem(LAYOUT_STORAGE_KEY);
    window.location.reload();
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        height: "100%",
      }}
    >
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <InstrumentPicker
          aria-label="Green instrument"
          linkGroup="green"
          placeholder="Green: search ric"
          showLinkGroupSelector
          style={{ width: 260 }}
        />
        <Button onClick={reset}>Reset layout</Button>
      </div>
      <LayoutProvider onLayoutChange={handleLayoutChange}>
        <FlexboxLayout
          id={ID.root}
          path=""
          style={{ flex: 1, flexDirection: "row", minHeight: 0 }}
        >
          <FlexboxLayout
            id={ID.left}
            resizeable
            style={{ ...fill, flexGrow: 1.4, flexDirection: "column" }}
          >
            <View
              id={ID.grid}
              header
              resizeable
              style={fill}
              title="Instruments"
            >
              <InstrumentGrid
                defaultLinkGroup="red"
                id={ID.gridTable}
                showLinkGroupSelector
                simulatedOnly
                style={content}
              />
            </View>
            <StackLayout
              id={ID.blotters}
              showTabs="top"
              style={fill}
              active={0}
            >
              <View id={ID.orders} title="Orders">
                <OrderBlotter
                  defaultLinkGroup="red"
                  showLinkGroupSelector
                  style={content}
                />
              </View>
              <View id={ID.fills} title="Fills">
                <FillsBlotter
                  defaultLinkGroup="red"
                  showLinkGroupSelector
                  style={content}
                />
              </View>
              <View id={ID.positions} title="Positions">
                <PositionsView
                  defaultLinkGroup="green"
                  showLinkGroupSelector
                  style={content}
                />
              </View>
            </StackLayout>
          </FlexboxLayout>
          <FlexboxLayout
            id={ID.middle}
            resizeable
            style={{ ...fill, flexDirection: "column" }}
          >
            <View id={ID.ticket} header resizeable style={fill} title="Ticket">
              <OrderTicketPanel
                defaultLinkGroup="red"
                showLinkGroupSelector
                style={content}
              />
            </View>
            <View id={ID.depth} header resizeable style={fill} title="Depth">
              <MarketDepth
                account={ACCOUNT}
                defaultLinkGroup="red"
                showLinkGroupSelector
              />
            </View>
          </FlexboxLayout>
          <FlexboxLayout
            id={ID.right}
            resizeable
            style={{ ...fill, flexDirection: "column" }}
          >
            <View
              id={ID.ladder}
              header
              resizeable
              style={{ ...fill, flexGrow: 2 }}
              title="Ladder"
            >
              <PriceLadder
                account={ACCOUNT}
                defaultLinkGroup="green"
                defaultQuantity={100}
                showLinkGroupSelector
                style={content}
              />
            </View>
            <View id={ID.tape} header resizeable style={fill} title="Tape">
              <TradeTape
                defaultLinkGroup="green"
                showLinkGroupSelector
                style={content}
              />
            </View>
          </FlexboxLayout>
        </FlexboxLayout>
      </LayoutProvider>
    </div>
  );
};
