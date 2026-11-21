import {
  ExportCsvButton,
  InstrumentLookupProvider,
  isLocalEngineDataSource,
  registerTradingCellRenderers,
  TradesView,
  TradingRenderer,
  useTradingDataSource,
} from "@heswell/trading-ui";
import type { DataSource, DataSourceFilter } from "@vuu-ui/vuu-data-types";
import { Table } from "@vuu-ui/vuu-table";
import type { TableConfig } from "@vuu-ui/vuu-table-types";
import { type ReactNode, useEffect, useState } from "react";
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

/** Filter box and ExportCsvButton over a trades table. */
const ExportPanel = ({
  dataSource,
  info,
}: {
  dataSource: DataSource;
  info?: ReactNode;
}) => {
  const [config, setConfig] = useState(initialConfig);
  const [filter, setFilter] = useState("");

  const applyFilter = (text: string) => {
    setFilter(text);
    dataSource.filter = { filter: text } as DataSourceFilter;
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
        <ExportCsvButton
          baseUrl={remoteConnection().authUrl}
          dataSource={dataSource}
          fileName="trades.csv"
          table="trades"
          tableConfig={config}
        />
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

/**
 * The trader UI's Trades panel: every trade, sortable, scoped to all
 * instruments or the linked one, with Export CSV in the toolbar.
 */
export const TradesViewExample = () => (
  <TradesView showLinkGroupSelector style={{ height: "100%" }} />
);
