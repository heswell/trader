import { BotDetail, BotsGrid } from "@heswell/trading-ui";
import { FlexboxLayout, LayoutProvider, View } from "@vuu-ui/vuu-layout";
import { useState } from "react";
import {
  FeatureFrame,
  type LinkedFeatureProps,
  withFeatureRoot,
} from "./shared";

const content = { height: "100%", minHeight: 0 };

/**
 * Simulator bots (module gated by sim-admin): every bot with its position,
 * P&L and order flow; the selected bot's stats and parameters beside it.
 */
const SimulatorBots = ({ defaultLinkGroup = "red" }: LinkedFeatureProps) => {
  const [botId, setBotId] = useState<string>();
  return (
    <FeatureFrame>
      <LayoutProvider>
        <FlexboxLayout
          id="sim-bots-root"
          path=""
          style={{ flex: 1, flexDirection: "row", minHeight: 0 }}
        >
          <View
            header
            id="sim-bots-grid"
            resizeable
            style={{ flexBasis: 0, flexGrow: 3, flexShrink: 1 }}
            title="Bots"
          >
            <BotsGrid
              defaultGrouping="none"
              defaultLinkGroup={defaultLinkGroup}
              id="sim-bots-grid-table"
              onBotSelect={setBotId}
              showLinkGroupSelector
              style={content}
            />
          </View>
          <View
            header
            id="sim-bots-detail"
            resizeable
            style={{ flexBasis: 0, flexGrow: 1, flexShrink: 1 }}
            title="Bot"
          >
            <BotDetail botId={botId} style={content} />
          </View>
        </FlexboxLayout>
      </LayoutProvider>
    </FeatureFrame>
  );
};

export default withFeatureRoot(SimulatorBots, "SimulatorBots");
