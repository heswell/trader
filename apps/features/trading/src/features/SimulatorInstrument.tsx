import {
  ACTIVE_LINK_GROUP,
  BotFillsTape,
  BotsGrid,
  SimInstrumentChart,
  SimInstrumentControls,
} from "@heswell/trading-ui";
import { FlexboxLayout, LayoutProvider, View } from "@vuu-ui/vuu-layout";
import {
  FeatureFrame,
  type PickerFeatureProps,
  ToolbarPicker,
  useFeatureLinkGroup,
  withFeatureRoot,
} from "./shared";

const content = { height: "100%", minHeight: 0 };
const pane = (grow: number) => ({
  flexBasis: 0,
  flexGrow: grow,
  flexShrink: 1,
});

/**
 * Simulator instrument (module gated by sim-admin), following the linked
 * instrument: fair value, walk and quotes with signed volume by owner
 * group beside its controls (price model, jumps, rates, halt, add bot);
 * the instrument's bots; and its attributed fills with markouts.
 */
const SimulatorInstrument = ({
  defaultLinkGroup = ACTIVE_LINK_GROUP,
  showInstrumentPicker = true,
}: PickerFeatureProps) => {
  const { followsActive, linkGroup, setLinkGroup } = useFeatureLinkGroup(
    "SimInstrumentChart:sim-instrument-chart",
    defaultLinkGroup,
  );
  return (
    <FeatureFrame
      toolbar={
        showInstrumentPicker && !followsActive ? (
          <ToolbarPicker id="sim-instrument-picker" linkGroup={linkGroup} />
        ) : undefined
      }
    >
      <LayoutProvider>
        <FlexboxLayout
          id="sim-instrument-root"
          path=""
          style={{ flex: 1, flexDirection: "column", minHeight: 0 }}
        >
          <FlexboxLayout
            id="sim-instrument-top"
            path=""
            style={{ ...pane(3), flexDirection: "row" }}
          >
            <View
              header
              id="sim-instrument-chart-view"
              resizeable
              style={pane(2)}
              title="Fair value and flow"
            >
              <SimInstrumentChart
                id="sim-instrument-chart"
                linkGroup={linkGroup}
                onLinkGroupChange={setLinkGroup}
                showLinkGroupSelector
                style={content}
              />
            </View>
            <View
              header
              id="sim-instrument-controls-view"
              resizeable
              style={{ flexBasis: 360, flexGrow: 0, flexShrink: 0 }}
              title="Controls"
            >
              <SimInstrumentControls
                id="sim-instrument-controls"
                linkGroup={linkGroup}
                style={content}
              />
            </View>
          </FlexboxLayout>
          <FlexboxLayout
            id="sim-instrument-bottom"
            path=""
            style={{ ...pane(2), flexDirection: "row" }}
          >
            <View
              header
              id="sim-instrument-bots"
              resizeable
              style={pane(1)}
              title="Bots"
            >
              <BotsGrid
                defaultGrouping="none"
                followInstrument
                id="sim-instrument-bots-grid"
                linkGroup={linkGroup}
                style={content}
              />
            </View>
            <View
              header
              id="sim-instrument-fills"
              resizeable
              style={pane(1)}
              title="Attributed fills"
            >
              <BotFillsTape
                id="sim-instrument-fills-tape"
                linkGroup={linkGroup}
                style={content}
              />
            </View>
          </FlexboxLayout>
        </FlexboxLayout>
      </LayoutProvider>
    </FeatureFrame>
  );
};

export default withFeatureRoot(SimulatorInstrument, "SimulatorInstrument");
