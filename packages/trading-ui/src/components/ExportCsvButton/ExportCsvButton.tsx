import { Button } from "@salt-ds/core";
import { useComponentCssInjection } from "@salt-ds/styles";
import { useWindow } from "@salt-ds/window";
import cx from "clsx";
import { type HTMLAttributes, useEffect } from "react";
import { canStreamToFile } from "../../export/exportViewport";
import { formatQuantity } from "../../utils/formatting";
import {
  type UseViewportExportProps,
  type ViewportExportStatus,
  useViewportExport,
} from "./useViewportExport";

import exportCsvButtonCss from "./ExportCsvButton.css";

const classBase = "tradingExportCsvButton";

/** How long the result stays next to the button. */
const RESULT_MS = 8_000;

const DownloadIcon = () => (
  <svg
    aria-hidden="true"
    fill="none"
    height={14}
    stroke="currentColor"
    strokeWidth={1.4}
    viewBox="0 0 14 14"
    width={14}
  >
    <path d="M7 2v7M4 6.5L7 9.5l3-3M2.5 12h9" />
  </svg>
);

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/** The status text next to the button, and its full form for the tooltip. */
export const exportStatusText = (
  status: ViewportExportStatus,
): { text: string; title?: string } => {
  switch (status.state) {
    case "idle":
      return { text: "" };
    case "running": {
      const { rows, rowCount } = status;
      const pct = rowCount > 0 ? Math.floor((100 * rows) / rowCount) : 0;
      return {
        text: rowCount > 0 ? `${pct}%` : "Starting…",
        title: `${formatQuantity(rows)} of ${formatQuantity(rowCount)} rows`,
      };
    }
    case "done": {
      const { rows, bytes, ms, snapshotMs, firstRowsMs, sink } = status.result;
      return {
        text: `${formatQuantity(rows)} rows in ${seconds(ms)}`,
        title: [
          `${formatQuantity(rows)} rows, ${(bytes / 1e6).toFixed(1)} MB in ${seconds(ms)}`,
          `snapshot ${Math.round(snapshotMs)} ms`,
          `first rows ${firstRowsMs === undefined ? "–" : `${Math.round(firstRowsMs)} ms`}`,
          `${formatQuantity(Math.round(rows / (ms / 1000)))} rows/s`,
          sink === "file" ? "streamed to file" : "downloaded from memory",
        ].join(" · "),
      };
    }
    case "cancelled":
      return { text: "Cancelled" };
    case "error":
      return { text: "Export failed", title: status.message };
  }
};

export interface ExportCsvButtonProps
  extends UseViewportExportProps,
    Omit<HTMLAttributes<HTMLSpanElement>, "title"> {
  /** Button text. Default "Export CSV". */
  label?: string;
  /** Disable the button (e.g. while disconnected). */
  disabled?: boolean;
}

/**
 * Export CSV for a panel's Table: every row of its data source in the
 * current filter and sort, formatted as the grid shows it (see
 * useViewportExport). While it runs the button cancels it and shows
 * progress; the result (rows, time; size and throughput on hover) stays
 * for a few seconds.
 */
export const ExportCsvButton = ({
  baseUrl,
  className,
  dataSource,
  disabled = false,
  fileName,
  label = "Export CSV",
  table,
  tableConfig,
  textFormatters,
  ...htmlAttributes
}: ExportCsvButtonProps) => {
  const targetWindow = useWindow();
  useComponentCssInjection({
    testId: "trading-export-csv-button",
    css: exportCsvButtonCss,
    window: targetWindow,
  });
  const { status, exportCsv, cancel, reset } = useViewportExport({
    baseUrl,
    dataSource,
    fileName,
    table,
    tableConfig,
    textFormatters,
  });
  const running = status.state === "running";
  const finished = !running && status.state !== "idle";
  useEffect(() => {
    if (!finished) return;
    const timer = setTimeout(reset, RESULT_MS);
    return () => clearTimeout(timer);
  }, [finished, reset]);
  const { text, title } = exportStatusText(status);

  return (
    <span
      {...htmlAttributes}
      className={cx(classBase, className)}
      data-state={status.state}
    >
      {running ? (
        <Button
          appearance="bordered"
          aria-label="Cancel export"
          onClick={cancel}
          sentiment="neutral"
        >
          Cancel
        </Button>
      ) : (
        <Button
          appearance="bordered"
          disabled={disabled}
          onClick={() => void exportCsv()}
          sentiment="neutral"
          title={
            canStreamToFile()
              ? "Every row in the current filter and sort, streamed to a file"
              : "Every row in the current filter and sort"
          }
        >
          <DownloadIcon />
          {label}
        </Button>
      )}
      <output
        aria-live="polite"
        className={`${classBase}-status`}
        data-testid="export-csv-status"
        title={title}
      >
        {text}
      </output>
    </span>
  );
};
