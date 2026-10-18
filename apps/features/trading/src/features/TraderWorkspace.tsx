import {
  AccountSelector,
  FillsBlotter,
  InstrumentGrid,
  InstrumentPicker,
  LINK_GROUP_PERSIST_PREFIX,
  DepthChartView,
  MarketDepth,
  OrderBlotter,
  PositionsView,
  PriceChart,
  TradeTape,
  useSelectedAccount,
} from "@heswell/trading-ui";
import { Button } from "@salt-ds/core";
import {
  RemoteModule,
  usePersistedState,
  usePortalModuleRegistry,
} from "@vuu-ui/core/portal";
import {
  FlexboxLayout,
  LayoutProvider,
  StackLayout,
  setPersistentState,
  View,
} from "@vuu-ui/vuu-layout";
import { type CSSProperties, useCallback, useState } from "react";
import { FeatureFrame, withFeatureRoot } from "./shared";

/** Stable View ids: they key each View's saved state (incl. its link group). */
export const VIEW_ID = {
  root: "tw-root",
  left: "tw-left",
  grid: "tw-grid",
  blotters: "tw-blotters",
  orders: "tw-orders",
  fills: "tw-fills",
  positions: "tw-positions",
  middle: "tw-middle",
  ticket: "tw-ticket",
  market: "tw-market",
  chart: "tw-chart",
  depth: "tw-depth",
  depthChart: "tw-depth-chart",
  right: "tw-right",
  ladder: "tw-ladder",
  tape: "tw-tape",
} as const;

/** Names of the nested child modules (default-modules.yaml). */
export const CHILD_MODULE = {
  ticket: "TradingWorkspaceTicket",
  ladder: "TradingWorkspaceLadder",
} as const;

/** Key of the saved View states in the module's portal saved state. */
export const LAYOUT_STATE_KEY = "trader-workspace.views";

interface LayoutNode {
  id?: string;
  state?: unknown;
  children?: LayoutNode[];
}
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type ViewStates = { [id: string]: { [key: string]: Json } };

/** The per-View states of a serialized vuu-layout (where link groups live). */
export const collectViewStates = (
  node: LayoutNode | undefined,
  out: ViewStates = {},
) => {
  if (!node) return out;
  if (node.id && node.state && typeof node.state === "object")
    out[node.id] = node.state as { [key: string]: Json };
  for (const child of node.children ?? []) collectViewStates(child, out);
  return out;
};

const fill: CSSProperties = { flexBasis: 0, flexGrow: 1, flexShrink: 1 };
const content: CSSProperties = { height: "100%", minHeight: 0 };
const notEntitled: CSSProperties = {
  alignItems: "center",
  color: "var(--salt-content-secondary-foreground)",
  display: "flex",
  height: "100%",
  justifyContent: "center",
  padding: 16,
  textAlign: "center",
};

/** Renders a nested child module if the portal registered it for this user. */
const ChildModule = ({
  name,
  fallback,
}: {
  name: string;
  fallback: string;
}) => {
  const { remoteModules } = usePortalModuleRegistry();
  const module = remoteModules.find((m) => m.name === name);
  if (!module) return <div style={notEntitled}>{fallback}</div>;
  const { clientIdentifier, mfComponent, mfScope, mfUrl, title, version } =
    module;
  return (
    <RemoteModule
      clientIdentifier={clientIdentifier}
      mfComponent={mfComponent}
      mfScope={mfScope}
      mfUrl={mfUrl}
      title={title}
      version={version}
    />
  );
};

/**
 * The prebuilt trader workspace: the default layout below, two link groups
 * (red follows the instrument grid: ticket, chart, depth, depth chart,
 * orders, fills; green follows the picker: ladder, tape, positions). Ticket and ladder are nested
 * child modules gated by trading-execute. View states and each component's
 * link group are saved in the module's portal saved state and restored on
 * load; "Reset layout" returns to the default.
 */
const TraderWorkspace = () => {
  const persisted = usePersistedState();
  const [account, setAccount, accounts] = useSelectedAccount();
  const [generation, setGeneration] = useState(() => {
    const saved = persisted.load<ViewStates>(LAYOUT_STATE_KEY);
    if (saved && typeof saved === "object")
      for (const [id, state] of Object.entries(saved))
        setPersistentState(id, state);
    return 0;
  });
  const { remoteModules } = usePortalModuleRegistry();
  const canTrade = remoteModules.some((m) => m.name === CHILD_MODULE.ticket);

  const handleLayoutChange = useCallback(
    (layout: object) => {
      persisted.save(collectViewStates(layout as LayoutNode), LAYOUT_STATE_KEY);
    },
    [persisted],
  );
  const reset = () => {
    persisted.save({}, LAYOUT_STATE_KEY);
    // trading-ui is an MF singleton bound to the host's vuu-layout, so its
    // components don't see this remote's Views and keep their link group in
    // the module's portal state instead (docs/portal-integration.md)
    for (const key of Object.keys(persisted.load() ?? {}))
      if (key.startsWith(LINK_GROUP_PERSIST_PREFIX)) persisted.save(null, key);
    for (const id of Object.values(VIEW_ID)) setPersistentState(id, {});
    setGeneration((g) => g + 1);
  };

  return (
    <FeatureFrame
      toolbar={
        <>
          <InstrumentPicker
            aria-label="Green instrument"
            id="tw-green-picker"
            linkGroup="green"
            placeholder="Green: search ric"
            showLinkGroupSelector
            style={{ width: 260 }}
          />
          <AccountSelector
            accounts={accounts}
            onChange={setAccount}
            value={account}
          />
          <Button onClick={reset}>Reset layout</Button>
        </>
      }
    >
      <LayoutProvider key={generation} onLayoutChange={handleLayoutChange}>
        <FlexboxLayout
          id={VIEW_ID.root}
          path=""
          style={{ flex: 1, flexDirection: "row", minHeight: 0 }}
        >
          <FlexboxLayout
            id={VIEW_ID.left}
            resizeable
            style={{ ...fill, flexGrow: 1.4, flexDirection: "column" }}
          >
            <View
              id={VIEW_ID.grid}
              header
              resizeable
              style={fill}
              title="Instruments"
            >
              <InstrumentGrid
                defaultLinkGroup="red"
                id="tw-grid-table"
                launchOrderTicket={canTrade}
                showLinkGroupSelector
                style={content}
              />
            </View>
            <StackLayout
              active={0}
              id={VIEW_ID.blotters}
              showTabs="top"
              style={fill}
            >
              <View id={VIEW_ID.orders} title="Orders">
                <OrderBlotter
                  defaultLinkGroup="red"
                  readOnly={!canTrade}
                  showLinkGroupSelector
                  style={content}
                  useEditSession
                />
              </View>
              <View id={VIEW_ID.fills} title="Fills">
                <FillsBlotter
                  defaultLinkGroup="red"
                  showLinkGroupSelector
                  style={content}
                />
              </View>
              <View id={VIEW_ID.positions} title="Positions">
                <PositionsView
                  defaultLinkGroup="green"
                  showLinkGroupSelector
                  style={content}
                />
              </View>
            </StackLayout>
          </FlexboxLayout>
          <FlexboxLayout
            id={VIEW_ID.middle}
            resizeable
            style={{ ...fill, flexDirection: "column" }}
          >
            <View
              id={VIEW_ID.ticket}
              header
              resizeable
              style={fill}
              title="Ticket"
            >
              <ChildModule
                fallback="Order entry needs the trading-execute role."
                name={CHILD_MODULE.ticket}
              />
            </View>
            <StackLayout
              active={0}
              id={VIEW_ID.market}
              showTabs="top"
              style={{ ...fill, flexGrow: 1.5 }}
            >
              <View id={VIEW_ID.chart} title="Chart">
                <PriceChart
                  account={account}
                  defaultLinkGroup="red"
                  id="tw-price-chart"
                  showLinkGroupSelector
                  style={content}
                />
              </View>
              <View id={VIEW_ID.depth} title="Depth">
                <MarketDepth
                  account={account}
                  defaultLinkGroup="red"
                  showLinkGroupSelector
                  style={content}
                />
              </View>
              <View id={VIEW_ID.depthChart} title="Depth chart">
                <DepthChartView
                  defaultLinkGroup="red"
                  id="tw-depth-chart-view"
                  showLinkGroupSelector
                  style={content}
                />
              </View>
            </StackLayout>
          </FlexboxLayout>
          <FlexboxLayout
            id={VIEW_ID.right}
            resizeable
            style={{ ...fill, flexDirection: "column" }}
          >
            <View
              id={VIEW_ID.ladder}
              header
              resizeable
              style={{ ...fill, flexGrow: 2 }}
              title="Ladder"
            >
              <ChildModule
                fallback="The price ladder needs the trading-execute role."
                name={CHILD_MODULE.ladder}
              />
            </View>
            <View id={VIEW_ID.tape} header resizeable style={fill} title="Tape">
              <TradeTape
                defaultLinkGroup="green"
                showLinkGroupSelector
                style={content}
              />
            </View>
          </FlexboxLayout>
        </FlexboxLayout>
      </LayoutProvider>
    </FeatureFrame>
  );
};

export default withFeatureRoot(TraderWorkspace, "TradingTraderWorkspace");
