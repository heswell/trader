import {
  MetricHistoryChart,
  MetricsGrid,
  MetricsProcessStrip,
  MetricsSessionsGrid,
  MetricsTablesGrid,
  type SelectedMetric,
} from "@heswell/trading-ui";
import { useState } from "react";

const fill = { height: "100%", minHeight: 0 } as const;
const pane = { flex: 1, minHeight: 0, minWidth: 0 } as const;

/**
 * The Server metrics feature's parts on the in-browser data: metrics and
 * tables grids beside the selected metric's history. The browser has no
 * process stats, so the process strip says so.
 */
export const ServerMetricsExample = () => {
  const [metric, setMetric] = useState<SelectedMetric>({
    id: "exchange.step",
    kind: "timer",
    unit: "us",
  });
  const select = (next: SelectedMetric | undefined) => {
    if (next) setMetric(next);
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, ...fill }}>
      <MetricsProcessStrip onSelectMetric={select} />
      <div style={{ display: "flex", flex: 2, gap: 16, minHeight: 0 }}>
        <div style={{ ...pane, flex: 3 }}>
          <MetricsGrid onSelectMetric={select} />
        </div>
        <div style={{ ...pane, flex: 2 }}>
          <MetricHistoryChart metric={metric} />
        </div>
      </div>
      <div style={pane}>
        <MetricsTablesGrid onSelectMetric={select} />
      </div>
      <div style={pane}>
        <MetricsSessionsGrid />
      </div>
    </div>
  );
};
