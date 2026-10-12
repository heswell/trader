import { OrderBlotter, PositionsView } from "@heswell/trading-ui";
import { FlexboxLayout, LayoutProvider, View } from "@vuu-ui/vuu-layout";
import { FeatureFrame, useEntitlements, withFeatureRoot } from "./shared";

const fill = { flexBasis: 0, flexGrow: 1, flexShrink: 1 };
const content = { height: "100%", minHeight: 0 };

/**
 * Supervisor view (module gated by trading-supervisor): every desk's orders
 * including child orders, and positions grouped by account. The OMS shows a
 * supervisor all accounts; acting on them also needs trading-execute.
 */
const Supervisor = () => {
  const { canTrade } = useEntitlements();
  return (
    <FeatureFrame>
      <LayoutProvider>
        <FlexboxLayout
          id="sv-root"
          path=""
          style={{ flex: 1, flexDirection: "column", minHeight: 0 }}
        >
          <View
            header
            id="sv-orders"
            resizeable
            style={fill}
            title="All orders"
          >
            <OrderBlotter
              defaultLinkGroup="red"
              defaultTab="all"
              id="sv-orders-blotter"
              readOnly={!canTrade}
              showChildOrders
              showLinkGroupSelector
              style={content}
            />
          </View>
          <View
            header
            id="sv-positions"
            resizeable
            style={fill}
            title="Positions by account"
          >
            <PositionsView
              defaultGrouping="account"
              defaultLinkGroup="red"
              id="sv-positions-view"
              showLinkGroupSelector
              showTotals
              style={content}
            />
          </View>
        </FlexboxLayout>
      </LayoutProvider>
    </FeatureFrame>
  );
};

export default withFeatureRoot(Supervisor, "TradingSupervisor");
