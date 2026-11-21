import type { TradingSchemaName } from "@heswell/trading-schemas";
import { useData } from "@vuu-ui/core";
import type { DataSource } from "@vuu-ui/vuu-data-types";
import type { TableConfig } from "@vuu-ui/vuu-table-types";
import { Range } from "@vuu-ui/vuu-utils";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useInstrumentLookup } from "../InstrumentLookup";
import { tradingTableSchema, tradingVuuTable } from "../../data/tradingTables";
import {
  type CellTextFormatters,
  exportColumns,
} from "../../export/exportColumns";
import {
  type ExportResult,
  exportViewportToCsv,
  pickExportSink,
} from "../../export/exportViewport";
import { tradingTextFormatters } from "../../export/tradingTextFormatters";

export type ViewportExportStatus =
  | { state: "idle" }
  | { state: "running"; rows: number; rowCount: number }
  | { state: "done"; result: ExportResult }
  | { state: "cancelled" }
  | { state: "error"; message: string };

export interface UseViewportExportProps {
  /** The trading table the data source is on. */
  table: TradingSchemaName;
  /** The data source the panel's Table shows: its filter and sort are used. */
  dataSource: DataSource;
  /** The Table's config: visible columns, their order, labels and formats. */
  tableConfig: TableConfig;
  /** Suggested file name, e.g. "fills.csv". */
  fileName: string;
  /** Text forms of the panel's own cell renderers, by renderer name. */
  textFormatters?: CellTextFormatters;
  /** Base for the export url if the server sends none (its REST url). */
  baseUrl?: string;
}

const SUBSCRIBE_TIMEOUT_MS = 10_000;

const isAbort = (error: unknown) =>
  error instanceof DOMException && error.name === "AbortError";

/**
 * Subscribe a temporary data source (one-row range, no rows wanted) and
 * resolve once its viewport exists on the server.
 */
const subscribeForExport = async (dataSource: DataSource) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const subscribed = new Promise<void>((resolve, reject) => {
    timer = setTimeout(
      () => reject(Error("export: viewport was not created")),
      SUBSCRIBE_TIMEOUT_MS,
    );
    dataSource.on("subscribed", () => resolve());
  });
  try {
    await dataSource.subscribe({ range: Range(0, 1) }, () => undefined);
    if (dataSource.status !== "subscribed") await subscribed;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Export what a panel's Table shows (every row, not just the visible range)
 * as CSV, formatted the way the grid formats it, in its current filter and
 * sort. Streams to a file the user picks where the browser can
 * (showSaveFilePicker), else downloads from memory.
 *
 * A grouped data source exports its leaf rows: the server snapshots flat
 * viewports only, so the export opens a temporary ungrouped viewport with
 * the same columns, filter and sort, and closes it when done.
 */
export const useViewportExport = ({
  table,
  dataSource,
  tableConfig,
  fileName,
  textFormatters,
  baseUrl,
}: UseViewportExportProps) => {
  const { VuuDataSource } = useData();
  const lookup = useInstrumentLookup();
  const [status, setStatus] = useState<ViewportExportStatus>({
    state: "idle",
  });
  const abortRef = useRef<AbortController>(undefined);
  useEffect(() => () => abortRef.current?.abort(), []);

  const columns = useMemo(() => {
    const schema = tradingTableSchema(table);
    return exportColumns(tableConfig.columns, {
      textFormatters: { ...tradingTextFormatters(lookup), ...textFormatters },
      serverDataTypes: Object.fromEntries(
        schema.columns.map((c) => [c.name, c.serverDataType]),
      ),
    });
  }, [table, tableConfig, lookup, textFormatters]);

  const exportCsv = useCallback(async () => {
    if (abortRef.current) return;
    const abort = new AbortController();
    abortRef.current = abort;
    let flat: DataSource | undefined;
    try {
      // the picker needs the click's user activation: before any other await
      const sink = await pickExportSink(fileName);
      setStatus({ state: "running", rows: 0, rowCount: 0 });
      let source = dataSource;
      if ((dataSource.groupBy?.length ?? 0) > 0) {
        flat = new VuuDataSource({
          table: tradingVuuTable(table),
          columns: dataSource.columns,
          filterSpec: dataSource.filter,
          sort: dataSource.sort,
        });
        await subscribeForExport(flat);
        source = flat;
      }
      const result = await exportViewportToCsv({
        dataSource: source,
        columns,
        sink,
        baseUrl,
        signal: abort.signal,
        // a late progress event must not overwrite done / cancelled / error
        onProgress: ({ rows, rowCount }) => {
          if (!abort.signal.aborted && abortRef.current === abort)
            setStatus({ state: "running", rows, rowCount });
        },
      });
      setStatus({ state: "done", result });
    } catch (error) {
      setStatus(
        isAbort(error)
          ? { state: "cancelled" }
          : {
              state: "error",
              message: error instanceof Error ? error.message : String(error),
            },
      );
    } finally {
      flat?.unsubscribe();
      abortRef.current = undefined;
    }
  }, [VuuDataSource, baseUrl, columns, dataSource, fileName, table]);

  const cancel = useCallback(() => abortRef.current?.abort(), []);
  const reset = useCallback(() => setStatus({ state: "idle" }), []);

  return { status, exportCsv, cancel, reset };
};
