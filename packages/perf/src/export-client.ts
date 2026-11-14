/**
 * One exporting client for export-load.ts (a separate process, so its CPU
 * never skews the latency clients). Logs in, opens a sorted, filtered
 * `trades` viewport and exports it:
 *
 * - `--mode=http`: EXPORT_VIEWPORT rpc, then the NDJSON over HTTP through
 *   the same client streams as the UI (ndjsonRows -> csvFormatter with the
 *   trading text formatters) to a CSV file;
 * - `--mode=ws-range`: the naive alternative, CHANGE_VP_RANGE to the whole
 *   viewport and wait until every row has arrived on the websocket.
 *
 * It also measures trade latency on its own session (a second, newest-first
 * trades viewport), since that is the session an export would delay most.
 * Prints `RESULT <json>` per export.
 */
import { parseArgs } from "node:util";
import {
  csvFormatter,
  exportColumns,
  ndjsonRows,
  tradingTextFormatters,
} from "../../trading-ui/src/export";
import { TradingRenderer } from "../../trading-ui/src/components/TradingCellRenderers/rendererNames";
import { tradingTableSchema } from "../../trading-ui/src/data/tradingTables";
import { VuuPerfClient } from "./lib/vuuPerfClient";

const { values: args } = parseArgs({
  options: {
    ws: { type: "string" },
    auth: { type: "string" },
    user: { type: "string", default: "exporter" },
    mode: { type: "string", default: "http" },
    filter: { type: "string", default: "" },
    out: { type: "string", default: "/dev/null" },
    count: { type: "string", default: "1" },
    table: { type: "string", default: "trades" },
  },
});
const table = args.table as string;

const TRADE_COLUMNS = [
  "tradeId",
  "ric",
  "price",
  "size",
  "aggressorSide",
  "timestamp",
  "seq",
];
const renderer = (name: string) => ({
  name: "string" as const,
  renderer: { name },
});
// the trades columns as a blotter would configure them
const tradeColumns = exportColumns(
  [
    { name: "timestamp", label: "Time", type: renderer(TradingRenderer.Time) },
    { name: "tradeId", label: "Trade id" },
    { name: "ric", label: "RIC" },
    {
      name: "aggressorSide",
      label: "Side",
      type: renderer(TradingRenderer.Side),
    },
    { name: "price", label: "Price", type: renderer(TradingRenderer.Price) },
    {
      name: "size",
      label: "Size",
      serverDataType: "long",
      type: { name: "number", formatting: { useLocaleString: true } },
    },
    { name: "seq", label: "Seq", serverDataType: "long" },
  ],
  { textFormatters: tradingTextFormatters() },
);
// other tables: every column, with vuu's default formatting for its type
const schema = tradingTableSchema(
  table as Parameters<typeof tradingTableSchema>[0],
);
const COLUMNS =
  table === "trades" ? TRADE_COLUMNS : schema.columns.map((c) => c.name);
const columns =
  table === "trades"
    ? tradeColumns
    : exportColumns(
        schema.columns.map(({ name, serverDataType }) => ({
          name,
          serverDataType,
        })),
      );
const exportSort =
  table === "trades"
    ? [
        { column: "ric", sortType: "A" as const },
        { column: "timestamp", sortType: "D" as const },
      ]
    : [
        { column: "ric", sortType: "A" as const },
        { column: schema.columns[3].name, sortType: "D" as const },
      ];

const token = await VuuPerfClient.fetchToken(args.auth as string, {
  username: args.user,
});
const client = await VuuPerfClient.login(args.ws as string, token);
const restBase = new URL(args.auth as string);

// own-session latency probe
const probeId = await client.createViewport({
  kind: "trades",
  module: "EXCHANGE",
  table: "trades",
  columns: TRADE_COLUMNS,
  range: { from: 0, to: 50 },
  sort: [{ column: "timestamp", sortType: "D" }],
  timestampColumn: "timestamp",
});
const tsIdx = TRADE_COLUMNS.indexOf("timestamp");
const ownLatency: [number, number][] = [];
client.listen((body) => {
  if (body.type !== "TABLE_ROW") return;
  const now = Date.now();
  for (const row of body.rows) {
    if (row.viewPortId === probeId && row.updateType === "U") {
      const ts = row.data[tsIdx];
      if (typeof ts === "number") ownLatency.push([now, now - ts]);
    }
  }
});

const exportVp = await client.createViewport({
  kind: "export",
  module: "EXCHANGE",
  table,
  columns: COLUMNS,
  filter: args.filter,
  range: { from: 0, to: 100 },
  sort: exportSort,
});

let peakRss = 0;
const rssTimer = setInterval(() => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
}, 50);

const percentile = (values: number[], p: number) => {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  ];
};

const rpc = async (rpcName: string, params: Record<string, unknown>) => {
  const response = client.waitFor(
    (body) =>
      body.type === "RPC_RESPONSE" &&
      (body as { rpcName: string }).rpcName === rpcName,
    30_000,
  );
  client.send("EXCHANGE", {
    context: { type: "VIEWPORT_CONTEXT", viewPortId: exportVp },
    params,
    rpcName,
    type: "RPC_REQUEST",
  });
  return ((await response) as unknown as { result: Record<string, any> })
    .result;
};

/** http without parsing / formatting: the server and transport cost alone. */
const httpRawExport = async () => {
  const t0 = performance.now();
  const result = await rpc("EXPORT_VIEWPORT", { columns: COLUMNS });
  if (result.type !== "SUCCESS_RESULT") throw Error(result.errorMessage);
  const ticket = result.data as {
    path: string;
    url?: string;
    rowCount: number;
  };
  const response = await fetch(ticket.url ?? new URL(ticket.path, restBase));
  if (!response.ok || !response.body) throw Error(`HTTP ${response.status}`);
  let wireBytes = 0;
  let firstByteMs: number | undefined;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    firstByteMs ??= performance.now() - t0;
    wireBytes += chunk.byteLength;
  }
  return {
    mode: "http-raw",
    rowCount: ticket.rowCount,
    rows: ticket.rowCount,
    firstByteMs,
    totalMs: performance.now() - t0,
    wireMB: wireBytes / 1e6,
  };
};

const httpExport = async () => {
  const t0 = performance.now();
  const result = await rpc("EXPORT_VIEWPORT", { columns: COLUMNS });
  if (result.type !== "SUCCESS_RESULT") throw Error(result.errorMessage);
  const ticket = result.data as {
    path: string;
    url?: string;
    rowCount: number;
  };
  const tTicket = performance.now();
  const response = await fetch(ticket.url ?? new URL(ticket.path, restBase));
  if (!response.ok || !response.body) throw Error(`HTTP ${response.status}`);
  let serverColumns: string[] = [];
  let rows = 0;
  let firstByteMs: number | undefined;
  let wireBytes = 0;
  let csvBytes = 0;
  const writer = Bun.file(args.out as string).writer();
  await response.body
    .pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          firstByteMs ??= performance.now() - t0;
          wireBytes += chunk.byteLength;
          controller.enqueue(chunk);
        },
      }),
    )
    .pipeThrough(
      new TextDecoderStream() as unknown as ReadableWritablePair<
        string,
        Uint8Array
      >,
    )
    .pipeThrough(
      ndjsonRows((names) => {
        serverColumns = names;
      }),
    )
    .pipeThrough(
      csvFormatter(columns, {
        sourceColumns: () => serverColumns,
        onProgress: (n) => {
          rows = n;
        },
      }),
    )
    .pipeThrough(new TextEncoderStream())
    .pipeTo(
      new WritableStream({
        async write(chunk) {
          csvBytes += chunk.byteLength;
          writer.write(chunk);
          await writer.flush();
        },
        async close() {
          await writer.end();
        },
      }),
    );
  return {
    mode: "http",
    rowCount: ticket.rowCount,
    rows,
    rpcMs: tTicket - t0,
    firstByteMs,
    totalMs: performance.now() - t0,
    wireMB: wireBytes / 1e6,
    csvMB: csvBytes / 1e6,
  };
};

const wsRangeExport = async () => {
  const t0 = performance.now();
  // the viewport size, from the SIZE row of the last TABLE_ROW
  let size = -1;
  const keys = new Set<string>();
  let wsBytes = 0;
  let maxFrameBytes = 0;
  const done = new Promise<void>((resolve) => {
    const stop = client.listen((body) => {
      if (body.type !== "TABLE_ROW") return;
      for (const row of body.rows) {
        if (row.viewPortId !== exportVp) continue;
        size = row.vpSize;
        if (row.updateType === "U") keys.add(row.rowKey);
      }
      if (size >= 0 && keys.size >= size) {
        stop();
        resolve();
      }
    });
  });
  const unsizedBytes = client.socket;
  const onMessage = ({ data }: MessageEvent) => {
    const n = String(data).length;
    wsBytes += n;
    if (n > maxFrameBytes) maxFrameBytes = n;
  };
  unsizedBytes.addEventListener("message", onMessage);
  client.send("CORE", {
    type: "CHANGE_VP_RANGE",
    viewPortId: exportVp,
    from: 0,
    to: 2_000_000,
  });
  await done;
  unsizedBytes.removeEventListener("message", onMessage);
  const result = {
    mode: "ws-range",
    rowCount: size,
    rows: keys.size,
    totalMs: performance.now() - t0,
    wireMB: wsBytes / 1e6,
    maxFrameMB: maxFrameBytes / 1e6,
  };
  client.send("CORE", {
    type: "CHANGE_VP_RANGE",
    viewPortId: exportVp,
    from: 0,
    to: 100,
  });
  return result;
};

const count = Number(args.count);
for (let i = 0; i < count; i++) {
  const from = Date.now();
  peakRss = process.memoryUsage().rss;
  const result =
    args.mode === "ws-range"
      ? await wsRangeExport()
      : args.mode === "http-raw"
        ? await httpRawExport()
        : await httpExport();
  const own = ownLatency.filter(([t]) => t >= from).map(([, l]) => l);
  console.log(
    `RESULT ${JSON.stringify({
      ...result,
      from,
      to: Date.now(),
      peakRssMB: peakRss / 2 ** 20,
      ownTradeLatencyP95: percentile(own, 95),
      ownTradeLatencyMax: percentile(own, 100),
      ownTradeSamples: own.length,
    })}`,
  );
}
clearInterval(rssTimer);
client.close();
process.exit(0);
