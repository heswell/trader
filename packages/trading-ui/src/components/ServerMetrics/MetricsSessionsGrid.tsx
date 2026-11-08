import { Table } from "@vuu-ui/vuu-table";
import type { TableConfig } from "@vuu-ui/vuu-table-types";
import cx from "clsx";
import { forwardRef, type HTMLAttributes } from "react";
import { useTradingDataSource } from "../../data/useTradingDataSource";
import { TradingRenderer } from "../TradingCellRenderers";
import { trendColumn } from "./MetricsGrid";
import { serverMetricsClass, useServerMetricsCss } from "./useServerMetricsCss";

const COLUMNS = [
  "id",
  "user",
  "connected",
  "queueLength",
  "rowsQueuedPerSec",
  "rowsSentPerSec",
  "coalescedPct",
  "messagesPerSec",
  "kbPerSec",
  "rowsSent",
  "rowsDropped",
];

const number = (decimals: number) => ({
  align: "right" as const,
  type: { name: "number" as const, formatting: { decimals } },
});

const tableConfig: TableConfig = {
  columnDefaultWidth: 90,
  rowSeparators: true,
  columns: [
    { name: "user", width: 110 },
    { name: "queueLength", label: "Queued", ...number(0), width: 80 },
    trendColumn("queueTrend", "queueLength", "Queue trend"),
    { name: "rowsSentPerSec", label: "Rows /s", ...number(1) },
    trendColumn("sentTrend", "rowsSentPerSec", "Rows trend"),
    { name: "coalescedPct", label: "Coalesced %", ...number(1), width: 100 },
    { name: "messagesPerSec", label: "Msgs /s", ...number(1) },
    { name: "kbPerSec", label: "KB /s", ...number(1) },
    { name: "rowsQueuedPerSec", label: "Queued /s", ...number(1) },
    { name: "rowsSent", label: "Rows sent", ...number(0), width: 110 },
    { name: "rowsDropped", label: "Dropped", ...number(0) },
    {
      name: "connected",
      width: 110,
      type: { name: "string", renderer: { name: TradingRenderer.Time } },
    },
    { name: "id", label: "Session", width: 140 },
  ],
};

export type MetricsSessionsGridProps = HTMLAttributes<HTMLDivElement>;

/**
 * Every client session on the Vuu server from `METRICS.metricsSessions`
 * (sim-admin only), most backed-up first: queued updates, rows and messages
 * sent per second, the share coalesced, and rows sent and dropped since
 * login. Empty on the in-browser data.
 */
export const MetricsSessionsGrid = forwardRef<
  HTMLDivElement,
  MetricsSessionsGridProps
>(function MetricsSessionsGrid({ className, ...htmlAttributes }, ref) {
  useServerMetricsCss();
  const dataSource = useTradingDataSource("metricsSessions", {
    columns: COLUMNS,
    sort: {
      sortDefs: [
        { column: "queueLength", sortType: "D" },
        { column: "rowsSentPerSec", sortType: "D" },
      ],
    },
  });
  return (
    <div
      {...htmlAttributes}
      className={cx(serverMetricsClass, className)}
      data-testid="trading-metrics-sessions-grid"
      ref={ref}
    >
      <div className={`${serverMetricsClass}-table`}>
        <Table config={tableConfig} dataSource={dataSource} />
      </div>
    </div>
  );
});
