import {
  BotsGrid,
  ScenarioRuns,
  SimBooksGrid,
  SimEventsLog,
  SimSessionStrip,
} from "@heswell/trading-ui";
import { FlexboxLayout, LayoutProvider, View } from "@vuu-ui/vuu-layout";
import {
  FeatureFrame,
  type LinkedFeatureProps,
  withFeatureRoot,
} from "./shared";

const fill = { flexBasis: 0, flexGrow: 1, flexShrink: 1 };
const content = { height: "100%", minHeight: 0 };

/**
 * Simulator overview (module gated by sim-admin): the session strip (phase
 * control, pause all bots, run a scenario), one row per simulated book
 * (phase, fair value against mid, spread, volatility, flow rates,
 * market-maker inventory), the bots grouped by kind, and scenario runs
 * beside the control audit log. Selecting a book or a bot links its
 * instrument.
 */
const SimulatorOverview = ({
  defaultLinkGroup = "red",
}: LinkedFeatureProps) => (
  <FeatureFrame>
    <LayoutProvider>
      <FlexboxLayout
        id="sim-overview-root"
        path=""
        style={{ flex: 1, flexDirection: "column", minHeight: 0 }}
      >
        <View
          header
          id="sim-overview-session"
          resizeable
          style={{ flexBasis: 120, flexGrow: 0, flexShrink: 0 }}
          title="Session and scenarios"
        >
          <SimSessionStrip style={content} />
        </View>
        <View
          header
          id="sim-overview-books"
          resizeable
          style={fill}
          title="Books"
        >
          <SimBooksGrid
            defaultLinkGroup={defaultLinkGroup}
            id="sim-overview-books-grid"
            showLinkGroupSelector
            style={content}
          />
        </View>
        <View
          header
          id="sim-overview-bots"
          resizeable
          style={fill}
          title="Bots by kind"
        >
          <BotsGrid
            defaultGrouping="kind"
            defaultLinkGroup={defaultLinkGroup}
            id="sim-overview-bots-grid"
            showLinkGroupSelector
            style={content}
          />
        </View>
        <FlexboxLayout
          id="sim-overview-control"
          path=""
          style={{ ...fill, flexDirection: "row" }}
        >
          <View
            header
            id="sim-overview-runs"
            resizeable
            style={fill}
            title="Scenario runs"
          >
            <ScenarioRuns style={content} />
          </View>
          <View
            header
            id="sim-overview-events"
            resizeable
            style={{ ...fill, flexGrow: 2 }}
            title="Control log"
          >
            <SimEventsLog style={content} />
          </View>
        </FlexboxLayout>
      </FlexboxLayout>
    </LayoutProvider>
  </FeatureFrame>
);

export default withFeatureRoot(SimulatorOverview, "SimulatorOverview");
