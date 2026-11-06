import { BotDetail, BotsGrid, SimBooksGrid } from "@heswell/trading-ui";
import { useState } from "react";

const fill = { height: "100%", minHeight: 0 } as const;
const pane = { flex: 1, minHeight: 0, minWidth: 0 } as const;

/** Books above bots; the selected bot's stats and parameters beside them. */
export const SimulatorMonitorExample = () => {
  const [botId, setBotId] = useState<string>();
  return (
    <div style={{ display: "flex", gap: 16, ...fill }}>
      <div
        style={{ display: "flex", flex: 3, flexDirection: "column", gap: 8 }}
      >
        <div style={pane}>
          <SimBooksGrid defaultSort="gap" />
        </div>
        <div style={pane}>
          <BotsGrid defaultGrouping="none" onBotSelect={setBotId} />
        </div>
      </div>
      <BotDetail botId={botId} style={{ flex: 1, minWidth: 240 }} />
    </div>
  );
};
