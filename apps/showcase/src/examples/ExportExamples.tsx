import {
  canStreamToFile,
  exportColumns,
  exportViewportToCsv,
  InstrumentLookupProvider,
  pickExportSink,
  registerTradingCellRenderers,
  TradingRenderer,
  tradingTableSchema,
  tradingTextFormatters,
  useInstrumentLookup,
  useTradingDataSource,
} from "@heswell/trading-ui";
import { Button } from "@salt-ds/core";
import type { DataSourceFilter } from "@vuu-ui/vuu-data-types";
import { Table } from "@vuu-ui/vuu-table";
import type { TableConfig } from "@vuu-ui/vuu-table-types";
import { useMemo, useRef, useState } from "react";
import { remoteConnection } from "../useShowcaseDataMode";

registerTradingCellRenderers();

const renderer = (name: string) => ({
  name: "string" as const,
  renderer: { name },
});

const COLUMNS = [
  "tradeId",
  "ric",
  "price",
  "size",
  "aggressorSide",
  "timestamp",
  "seq",
];

const initialConfig: TableConfig = {
  columnDefaultWidth: 110,
  rowSeparators: true,
  columns: [
    { name: "timestamp", label: "Time", type: renderer(TradingRenderer.Time) },
    { name: "tradeId", label: "Trade id", width: 140 },
    { name: "ric", label: "RIC", width: 90 },
    {
      name: "aggressorSide",
      label: "Side",
      width: 70,
      type: renderer(TradingRenderer.Side),
    },
    {
      name: "price",
      label: "Price",
      align: "right",
      type: renderer(TradingRenderer.Price),
    },
    {
      name: "size",
      label: "Size",
      align: "right",
      type: { name: "number", formatting: { useLocaleString: true } },
    },
    { name: "seq", label: "Seq", align: "right", width: 80 },
  ],
};

const serverDataTypes = Object.fromEntries(
  tradingTableSchema("trades").columns.map((c) => [c.name, c.serverDataType]),
);

type Status =
  | { state: "idle" }
  | { state: "running"; rows: number; rowCount: number }
  | { state: "done"; text: string }
  | { state: "error"; text: string };

const Inner = () => {
  const lookup = useInstrumentLookup();
  const dataSource = useTradingDataSource("trades", {
    columns: COLUMNS,
    sort: {
      sortDefs: [
        { column: "ric", sortType: "A" },
        { column: "timestamp", sortType: "D" },
      ],
    },
  });
  const [config, setConfig] = useState(initialConfig);
  const [filter, setFilter] = useState("");
  const [status, setStatus] = useState<Status>({ state: "idle" });
  const abortRef = useRef<AbortController>(undefined);
  const columns = useMemo(
    () =>
      exportColumns(config.columns, {
        textFormatters: tradingTextFormatters(lookup),
        serverDataTypes,
      }),
    [config, lookup],
  );

  const applyFilter = (text: string) => {
    setFilter(text);
    dataSource.filter = { filter: text } as DataSourceFilter;
  };

  const onExport = async () => {
    const abort = new AbortController();
    abortRef.current = abort;
    try {
      // the picker needs the click's user activation: before any other await
      const sink = await pickExportSink(`trades-${Date.now()}.csv`);
      setStatus({ state: "running", rows: 0, rowCount: 0 });
      const result = await exportViewportToCsv({
        dataSource,
        columns,
        sink,
        baseUrl: remoteConnection().authUrl,
        signal: abort.signal,
        onProgress: ({ rows, rowCount }) =>
          setStatus({ state: "running", rows, rowCount }),
      });
      setStatus({
        state: "done",
        text: `${result.rows.toLocaleString()} rows, ${(result.bytes / 1e6).toFixed(1)} MB in ${(result.ms / 1000).toFixed(1)}s (${result.sink === "file" ? "streamed to file" : "downloaded from memory"})`,
      });
    } catch (error) {
      const text =
        error instanceof DOMException && error.name === "AbortError"
          ? "cancelled"
          : String(error);
      setStatus({ state: "error", text });
    }
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        height: "100%",
      }}
    >
      <div style={{ alignItems: "center", display: "flex", gap: 8 }}>
        <label>
          Filter{" "}
          <input
            onChange={(e) => applyFilter(e.target.value)}
            placeholder='ric starts "A" and size > 100'
            style={{ width: 320 }}
            value={filter}
          />
        </label>
        {status.state === "running" ? (
          <Button onClick={() => abortRef.current?.abort()}>Cancel</Button>
        ) : (
          <Button data-testid="export-csv" onClick={onExport}>
            Export CSV
          </Button>
        )}
        <output data-testid="export-status">
          {status.state === "running"
            ? `${status.rows.toLocaleString()} / ${status.rowCount.toLocaleString()} rows…`
            : status.state === "idle"
              ? canStreamToFile()
                ? "streams to a file you pick"
                : "no showSaveFilePicker: buffers in memory, then downloads"
              : status.text}
        </output>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <Table
          config={config}
          dataSource={dataSource}
          onConfigChange={setConfig}
          renderBufferSize={20}
        />
      </div>
    </div>
  );
};

/**
 * The whole sorted, filtered trades viewport as CSV, formatted as the grid
 * shows it. Remote server only (the server snapshots the viewport and
 * streams it over HTTP).
 */
export const TradesExportExample = () => (
  <InstrumentLookupProvider>
    <Inner />
  </InstrumentLookupProvider>
);
