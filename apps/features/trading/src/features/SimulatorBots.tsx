import {
  BotDetail,
  BotsGrid,
  ClientBotDetail,
  ClientBotsGrid,
} from "@heswell/trading-ui";
import { FlexboxLayout, LayoutProvider, View } from "@vuu-ui/vuu-layout";
import { useState } from "react";
import {
  FeatureFrame,
  type LinkedFeatureProps,
  withFeatureRoot,
} from "./shared";

const content = { height: "100%", minHeight: 0 };

type Selection =
  | { type: "exchange"; botId: string }
  | { type: "client"; botId: string }
  | undefined;

/**
 * Simulator bots (module gated by sim-admin): the exchange bots with their
 * position, P&L and order flow above the OMS client bots (simulated clients
 * sending algo orders); the selected bot's stats and parameters beside them.
 */
const SimulatorBots = ({ defaultLinkGroup = "red" }: LinkedFeatureProps) => {
  const [selection, setSelection] = useState<Selection>();
  const select = (type: "exchange" | "client") => (botId: string | undefined) =>
    setSelection((current) =>
      botId ? { type, botId } : current?.type === type ? undefined : current,
    );
  return (
    <FeatureFrame>
      <LayoutProvider>
        <FlexboxLayout
          id="sim-bots-root"
          path=""
          style={{ flex: 1, flexDirection: "row", minHeight: 0 }}
        >
          <FlexboxLayout
            id="sim-bots-grids"
            path=""
            style={{
              flexBasis: 0,
              flexDirection: "column",
              flexGrow: 3,
              flexShrink: 1,
            }}
          >
            <View
              header
              id="sim-bots-grid"
              resizeable
              style={{ flexBasis: 0, flexGrow: 2, flexShrink: 1 }}
              title="Exchange bots"
            >
              <BotsGrid
                defaultGrouping="none"
                defaultLinkGroup={defaultLinkGroup}
                id="sim-bots-grid-table"
                onBotSelect={select("exchange")}
                showLinkGroupSelector
                style={content}
              />
            </View>
            <View
              header
              id="sim-client-bots-grid"
              resizeable
              style={{ flexBasis: 0, flexGrow: 1, flexShrink: 1 }}
              title="Client bots"
            >
              <ClientBotsGrid
                id="sim-client-bots-grid-table"
                onBotSelect={select("client")}
                style={content}
              />
            </View>
          </FlexboxLayout>
          <View
            header
            id="sim-bots-detail"
            resizeable
            style={{ flexBasis: 0, flexGrow: 1, flexShrink: 1 }}
            title="Bot"
          >
            {selection?.type === "client" ? (
              <ClientBotDetail botId={selection.botId} style={content} />
            ) : (
              <BotDetail botId={selection?.botId} style={content} />
            )}
          </View>
        </FlexboxLayout>
      </LayoutProvider>
    </FeatureFrame>
  );
};

export default withFeatureRoot(SimulatorBots, "SimulatorBots");
