import {
  BotDetail,
  BotFillsTape,
  BotsGrid,
  ScenarioRuns,
  SimBooksGrid,
  SimEventsLog,
  SimInstrumentChart,
  SimInstrumentControls,
  SimSessionStrip,
} from "@heswell/trading-ui";
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

/** One instrument: fair value and flow above its attributed fills. */
export const SimulatorInstrumentExample = () => (
  <div style={{ display: "flex", flexDirection: "column", gap: 8, ...fill }}>
    <div style={{ flex: 2, minHeight: 0 }}>
      <SimInstrumentChart ric="AAPL.OQ" />
    </div>
    <div style={{ flex: 1, minHeight: 0 }}>
      <BotFillsTape ric="AAPL.OQ" />
    </div>
  </div>
);

/**
 * Control: session strip (phase, pause all, run a scenario) above one
 * instrument's controls, scenario runs and the control log.
 */
export const SimulatorControlExample = () => (
  <div style={{ display: "flex", flexDirection: "column", gap: 8, ...fill }}>
    <SimSessionStrip />
    <div style={{ display: "flex", flex: 1, gap: 16, minHeight: 0 }}>
      <SimInstrumentControls ric="AAPL.OQ" style={{ flex: "0 0 360px" }} />
      <div
        style={{
          display: "flex",
          flex: 1,
          flexDirection: "column",
          gap: 8,
          minWidth: 0,
        }}
      >
        <ScenarioRuns style={{ flex: "0 0 auto", maxHeight: 200 }} />
        <SimEventsLog style={{ flex: 1, minHeight: 0 }} />
      </div>
    </div>
  </div>
);
