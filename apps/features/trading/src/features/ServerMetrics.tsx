import {
  MetricHistoryChart,
  MetricsGrid,
  MetricsProcessStrip,
  MetricsSessionsGrid,
  MetricsTablesGrid,
  type SelectedMetric,
} from "@heswell/trading-ui";
import { FlexboxLayout, LayoutProvider, View } from "@vuu-ui/vuu-layout";
import { useState } from "react";
import { FeatureFrame, withFeatureRoot } from "./shared";

const content = { height: "100%", minHeight: 0 };
const pane = (grow: number) => ({
  flexBasis: 0,
  flexGrow: grow,
  flexShrink: 1,
});

/** Charted until the user picks another metric. */
const DEFAULT_METRIC: SelectedMetric = {
  id: "process.cpuPct",
  kind: "gauge",
  unit: "%",
};

/**
 * Server metrics (module gated by sim-admin), from the trading server's
 * METRICS tables: the process (CPU, memory, event-loop lag) with sparklines
 * of its recent history; every metric (hot-path timers, counters, gauges)
 * beside the history chart of the selected one; table writes beside the
 * client sessions (queue depth and send rates per session). Clicking
 * a process card, a metric or a counted table charts its history.
 */
const ServerMetrics = () => {
  const [metric, setMetric] = useState<SelectedMetric>(DEFAULT_METRIC);
  const select = (next: SelectedMetric | undefined) => {
    if (next) setMetric(next);
  };
  return (
    <FeatureFrame>
      <LayoutProvider>
        <FlexboxLayout
          id="server-metrics-root"
          path=""
          style={{ flex: 1, flexDirection: "column", minHeight: 0 }}
        >
          <View
            header
            id="server-metrics-process"
            resizeable
            style={{ flexBasis: 110, flexGrow: 0, flexShrink: 0 }}
            title="Process"
          >
            <MetricsProcessStrip onSelectMetric={select} style={content} />
          </View>
          <FlexboxLayout
            id="server-metrics-main"
            path=""
            style={{ ...pane(3), flexDirection: "row" }}
          >
            <View
              header
              id="server-metrics-grid"
              resizeable
              style={pane(3)}
              title="Metrics"
            >
              <MetricsGrid onSelectMetric={select} style={content} />
            </View>
            <View
              header
              id="server-metrics-history"
              resizeable
              style={pane(2)}
              title="History"
            >
              <MetricHistoryChart metric={metric} style={content} />
            </View>
          </FlexboxLayout>
          <FlexboxLayout
            id="server-metrics-bottom"
            path=""
            style={{ ...pane(2), flexDirection: "row" }}
          >
            <View
              header
              id="server-metrics-tables"
              resizeable
              style={pane(3)}
              title="Tables"
            >
              <MetricsTablesGrid onSelectMetric={select} style={content} />
            </View>
            <View
              header
              id="server-metrics-sessions"
              resizeable
              style={pane(2)}
              title="Sessions"
            >
              <MetricsSessionsGrid style={content} />
            </View>
          </FlexboxLayout>
        </FlexboxLayout>
      </LayoutProvider>
    </FeatureFrame>
  );
};

export default withFeatureRoot(ServerMetrics, "ServerMetrics");
