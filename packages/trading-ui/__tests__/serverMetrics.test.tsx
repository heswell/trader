import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  createTradingTestData,
  setCurrentUser,
} from "@heswell/trading-test-data";
import { createTradingLocalServer } from "@heswell/trading-test-data/react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import {
  formatDuration,
  formatMetric,
  METRICS_COMPONENTS,
  MetricHistoryChart,
  MetricsGrid,
  MetricsProcessStrip,
  MetricsTablesGrid,
  metricHistoryAxis,
  metricHistorySeries,
  PROCESS_CARDS,
  TradingDataProvider,
} from "../src";

setCurrentUser({ name: "admin", authorizations: [] });
const testData = createTradingTestData({
  seed: 7,
  exchange: { activeInstruments: 2 },
  oms: { flowRate: 0 },
  manualClock: true,
});
const localServer = createTradingLocalServer(testData, "server-metrics");
testData.advance(1_000);
testData.advance(1_000);

afterEach(cleanup);
afterAll(() => testData.dispose());

const wrap = (children: React.ReactNode) => (
  <TradingDataProvider mode="local" localServer={localServer}>
    {children}
  </TradingDataProvider>
);

describe("server metrics", () => {
  // (the Table renders no rows at the test DOM's zero height; the rows
  // themselves are covered by trading-test-data's METRICS test)
  test("MetricsGrid offers a component filter", () => {
    render(wrap(<MetricsGrid defaultComponent="oms" />));
    const select = screen.getByLabelText("Component") as HTMLSelectElement;
    expect(select.value).toBe("oms");
    expect(Array.from(select.options).map((o) => o.value)).toEqual([
      ...METRICS_COMPONENTS,
    ]);
  });

  test("MetricsTablesGrid renders", () => {
    render(wrap(<MetricsTablesGrid />));
    expect(screen.getByTestId("trading-metrics-tables-grid")).toBeTruthy();
  });

  test("MetricsProcessStrip has a card per process value", async () => {
    render(wrap(<MetricsProcessStrip />));
    const strip = screen.getByTestId("trading-metrics-process");
    expect(strip.querySelectorAll("[data-metric]").length).toBe(
      PROCESS_CARDS.length,
    );
    // the local data has no process (browser): says so once loaded
    await waitFor(() =>
      expect(strip.textContent).toContain("No process metrics"),
    );
  });

  test("MetricHistoryChart waits for a metric", () => {
    render(wrap(<MetricHistoryChart />));
    expect(screen.getByText("Select a metric")).toBeTruthy();
    expect(screen.getByText("Metric history")).toBeTruthy();
  });

  test("series and axis follow the metric kind", () => {
    expect(metricHistorySeries("timer").map((s) => s.columnName)).toEqual([
      "p50",
      "p99",
      "max",
    ]);
    expect(metricHistorySeries("counter").map((s) => s.columnName)).toEqual([
      "rate",
    ]);
    expect(metricHistorySeries("gauge").map((s) => s.columnName)).toEqual([
      "value",
    ]);
    expect(metricHistoryAxis({ id: "a", kind: "counter", unit: "" })).toBe(
      "count /s",
    );
    expect(metricHistoryAxis({ id: "a", kind: "timer", unit: "us" })).toBe(
      "us",
    );
  });

  test("formatting", () => {
    expect(formatMetric(12345.6)).toBe("12,346");
    expect(formatMetric(12.34)).toBe("12.3");
    expect(formatMetric(0.04211)).toBe("0.042");
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(725)).toBe("12m 5s");
    expect(formatDuration(3 * 3600 + 240)).toBe("3h 4m");
    expect(formatDuration(2 * 86400 + 3 * 3600)).toBe("2d 3h");
  });
});
