import {
  canStreamToFile,
  type ExportColumn,
  type ExportResult,
  exportColumns,
  exportViewportToCsv,
  InstrumentLookupProvider,
  isLocalEngineDataSource,
  pickExportSink,
  registerTradingCellRenderers,
  TradingRenderer,
  tradingTableSchema,
  tradingTextFormatters,
  useInstrumentLookup,
  useTradingDataSource,
} from "@heswell/trading-ui";
import { Button } from "@salt-ds/core";
import type { DataSource, DataSourceFilter } from "@vuu-ui/vuu-data-types";
import { Table } from "@vuu-ui/vuu-table";
import type { TableConfig } from "@vuu-ui/vuu-table-types";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
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

const SORT = {
  sortDefs: [
    { column: "ric", sortType: "A" as const },
    { column: "timestamp", sortType: "D" as const },
  ],
};

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

const exportSummary = ({
  rows,
  bytes,
  ms,
  snapshotMs,
  firstRowsMs,
  sink,
}: ExportResult) =>
  [
    `${rows.toLocaleString()} rows, ${(bytes / 1e6).toFixed(1)} MB in ${(ms / 1000).toFixed(1)}s`,
    `snapshot ${Math.round(snapshotMs)}ms`,
    `first rows ${firstRowsMs === undefined ? "–" : `${Math.round(firstRowsMs)}ms`}`,
    `${Math.round(rows / (ms / 1000)).toLocaleString()} rows/s`,
    `${(bytes / 1e6 / (ms / 1000)).toFixed(1)} MB/s`,
    sink === "file" ? "streamed to file" : "downloaded from memory",
  ].join(" · ");

type Status =
  | { state: "idle" }
  | { state: "running"; rows: number; rowCount: number }
  | { state: "done"; text: string }
  | { state: "error"; text: string };

/** Filter box, Export CSV / Cancel and status over a trades table. */
const ExportPanel = ({
  dataSource,
  info,
}: {
  dataSource: DataSource;
  info?: ReactNode;
}) => {
  const lookup = useInstrumentLookup();
  const [config, setConfig] = useState(initialConfig);
  const [filter, setFilter] = useState("");
  const [status, setStatus] = useState<Status>({ state: "idle" });
  const abortRef = useRef<AbortController>(undefined);
  const columns: ExportColumn[] = useMemo(
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
        text: exportSummary(result),
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
      {info}
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

const LiveTrades = () => {
  const dataSource = useTradingDataSource("trades", {
    columns: COLUMNS,
    sort: SORT,
  });
  return <ExportPanel dataSource={dataSource} />;
};

/**
 * The whole sorted, filtered trades viewport as CSV, formatted as the grid
 * shows it. Remote: the server snapshots the viewport and streams it over
 * HTTP. Local: the in-browser engine's viewport is snapshot in the page.
 */
export const TradesExportExample = () => (
  <InstrumentLookupProvider>
    <LiveTrades />
  </InstrumentLookupProvider>
);

// ------------------------------------------------------------ 1M rows remote

const MILLION = 1_000_000;

/** The viewport's row count, polled (the table size changes as trades tick). */
const useViewportSize = (dataSource: DataSource) => {
  const [size, setSize] = useState(dataSource.size);
  useEffect(() => {
    const timer = setInterval(() => setSize(dataSource.size), 1_000);
    return () => clearInterval(timer);
  }, [dataSource]);
  return size;
};

const MillionTrades = () => {
  const dataSource = useTradingDataSource("trades", {
    columns: COLUMNS,
    sort: SORT,
  });
  const size = useViewportSize(dataSource);
  const local = isLocalEngineDataSource(dataSource);
  const hint = local
    ? "Switch to Remote server: this example exports from the trading server's trades table."
    : size < MILLION
      ? "Fewer than 1M trades: start the trading server with EXCHANGE_SIM_TRADES_SEED=1000000 (bun run dev:trading-server:1m)."
      : undefined;
  return (
    <ExportPanel
      dataSource={dataSource}
      info={
        <div data-testid="trades-size">
          Remote trades: {size.toLocaleString()} rows
          {hint ? <strong> — {hint}</strong> : null}
        </div>
      }
    />
  );
};

/**
 * Export from a 1M-row remote table: the trading server's trades table,
 * seeded with a million historical trades at startup and ticking on top.
 * Sort or filter it, then export: the server snapshots the viewport and
 * streams it over HTTP.
 */
export const MillionTradesExportExample = () => (
  <InstrumentLookupProvider>
    <MillionTrades />
  </InstrumentLookupProvider>
);
