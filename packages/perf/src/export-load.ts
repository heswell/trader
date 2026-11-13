/**
 * Viewport export under load: how long a large `trades` export takes, its
 * memory, and what it does to trade / price latency on other sessions.
 *
 *   bun ./packages/perf/src/export-load.ts                    # 500k trades, http
 *   bun ./packages/perf/src/export-load.ts --mode=both --rows=500000
 *
 * 1. starts the perf trading server (local target) with
 *    tradesCapacity=--rows, and waits until the trades ring is full (the
 *    ring then adds and evicts rows constantly);
 * 2. --clients latency sessions each watch newest-first trades and all
 *    prices (e2e latency: receipt - publish timestamp);
 * 3. a --baseline window with no export, then for each mode an export
 *    window in which a separate exporter process (export-client.ts) runs
 *    --exports exports back to back.
 *
 * Writes perf-results/export-load-<stamp>.{json,md}.
 */
import { resolve } from "node:path";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { startPerfServer } from "./lib/perfServer";
import {
  distribution,
  type Distribution,
  mdTable,
  parseArgs,
  resultsPath,
  round,
  sleep,
} from "./lib/util";
import { VuuPerfClient } from "./lib/vuuPerfClient";

const args = parseArgs();
const rows = Number(args.rows ?? 500_000);
const tick = Number(args.tick ?? 4);
const clients = Number(args.clients ?? 4);
const baselineSecs = Number(args.baseline ?? 15);
const exportsPerMode = Number(args.exports ?? 3);
const modes = (
  args.mode === "both" ? "http,http-raw,ws-range" : (args.mode ?? "http")
).split(",");
const settleSecs = Number(args.settle ?? 15);
const wsExports = Number(args["ws-exports"] ?? 1);
const table = args.table ?? "trades";
const filter =
  args.filter ??
  (table === "trades" ? 'aggressorSide = "BUY" or size > 0' : "");
const out = resultsPath("export-load");

const env = {
  EXCHANGE_SIM_TRADES_CAPACITY: String(rows),
  EXCHANGE_SIM_MM_RATE: String(10 * tick),
  EXCHANGE_SIM_TAKER_RATE: String(8 * tick),
  VUU_LOG_LEVEL: "info",
};
const serverExports: Record<string, unknown>[] = [];
const statsFile = `${out}-server.jsonl`;
console.log(`starting perf server: trades capacity ${rows}, tick x${tick}`);
const server = await startPerfServer({
  env,
  statsFile,
  onLine: (line) => {
    const m = line.match(
      /export (\S+) complete: (\d+)\/(\d+) rows, ([\d.]+)MB, (\d+) chunks in (\d+)ms, max chunk ([\d.]+)ms/,
    );
    if (m) {
      serverExports.push({
        rows: Number(m[2]),
        mb: Number(m[4]),
        chunks: Number(m[5]),
        streamMs: Number(m[6]),
        maxChunkMs: Number(m[7]),
      });
    }
    const s = line.match(
      /export (\S+) trades (\d+) rows .* snapshot ([\d.]+)ms/,
    );
    if (s)
      serverExports.push({
        snapshotRows: Number(s[2]),
        snapshotMs: Number(s[3]),
      });
  },
});

// ------------------------------------------------------------ latency clients

type Sample = [at: number, latency: number];
const samples: Record<"trades" | "prices", Sample[]> = {
  trades: [],
  prices: [],
};
const sessions: VuuPerfClient[] = [];
let tradesSize = 0;
let tableSize = 0;

for (let i = 0; i < clients; i++) {
  const token = await VuuPerfClient.fetchToken(server.authUrl, {
    username: `latency${i}`,
  });
  const client = await VuuPerfClient.login(server.wsUrl, token);
  sessions.push(client);
  const tradeCols = ["tradeId", "ric", "price", "size", "timestamp"];
  const priceCols = ["ric", "last", "timestamp"];
  const tradesVp = await client.createViewport({
    kind: "trades",
    module: "EXCHANGE",
    table: "trades",
    columns: tradeCols,
    range: { from: 0, to: 100 },
    sort: [{ column: "timestamp", sortType: "D" }],
  });
  const pricesVp = await client.createViewport({
    kind: "prices",
    module: "EXCHANGE",
    table: "prices",
    columns: priceCols,
    range: { from: 0, to: 500 },
  });
  client.listen((body) => {
    if (body.type !== "TABLE_ROW") return;
    const now = Date.now();
    for (const row of body.rows) {
      if (row.viewPortId === tradesVp) {
        tradesSize = row.vpSize;
        const ts = row.data[4];
        if (row.updateType === "U" && typeof ts === "number")
          samples.trades.push([now, now - ts]);
      } else if (row.viewPortId === pricesVp) {
        const ts = row.data[2];
        if (row.updateType === "U" && typeof ts === "number" && ts > 0)
          samples.prices.push([now, now - ts]);
      }
    }
  });
}

// ------------------------------------------------------------------ fill

if (table !== "trades") {
  const vp = await sessions[0].createViewport({
    kind: table,
    module: "EXCHANGE",
    table,
    columns: ["ric"],
    range: { from: 0, to: 1 },
  });
  sessions[0].listen((body) => {
    if (body.type !== "TABLE_ROW") return;
    for (const row of body.rows)
      if (row.viewPortId === vp) tableSize = row.vpSize;
  });
}

const fillStart = Date.now();
let lastLog = 0;
while (tradesSize < rows) {
  await sleep(1_000);
  if (Date.now() - lastLog > 10_000) {
    lastLog = Date.now();
    const secs = (Date.now() - fillStart) / 1_000;
    console.log(
      `filling trades: ${tradesSize.toLocaleString()} / ${rows.toLocaleString()} (${Math.round(tradesSize / secs)}/s)`,
    );
  }
  if (Date.now() - fillStart > 30 * 60_000)
    throw Error("trades fill timed out");
}
const fillSecs = (Date.now() - fillStart) / 1_000;
console.log(
  `trades full after ${fillSecs.toFixed(0)}s, settling ${settleSecs}s`,
);
if (table !== "trades")
  console.log(`${table}: ${tableSize.toLocaleString()} rows`);
await sleep(settleSecs * 1_000);

// ---------------------------------------------------------------- windows

type Window = {
  name: string;
  from: number;
  to: number;
  exports?: Record<string, unknown>[];
};
const windows: Window[] = [];

const runWindow = async (name: string, secs: number) => {
  const from = Date.now();
  await sleep(secs * 1_000);
  windows.push({ name, from, to: Date.now() });
};

const runExports = async (mode: string) => {
  const from = Date.now();
  const proc = Bun.spawn(
    [
      "bun",
      resolve(import.meta.dir, "export-client.ts"),
      `--ws=${server.wsUrl}`,
      `--auth=${server.authUrl}`,
      `--mode=${mode}`,
      `--filter=${filter}`,
      `--table=${table}`,
      `--count=${mode === "ws-range" ? wsExports : exportsPerMode}`,
      `--out=${out}-${mode}.csv`,
    ],
    { stdout: "pipe", stderr: "inherit" },
  );
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  const results = text
    .split("\n")
    .filter((line) => line.startsWith("RESULT "))
    .map((line) => JSON.parse(line.slice(7)) as Record<string, unknown>);
  windows.push({
    name: `export ${mode}`,
    from,
    to: Date.now(),
    exports: results,
  });
  for (const r of results) console.log(mode, JSON.stringify(r));
};

console.log(`baseline ${baselineSecs}s`);
await runWindow("baseline", baselineSecs);
for (const mode of modes) {
  console.log(`export window: ${mode}`);
  await runExports(mode);
  await runWindow(`after ${mode}`, baselineSecs);
}

for (const client of sessions) client.close();
await sleep(1_100);
await server.stop();

// ---------------------------------------------------------------- report

const inWindow = (list: Sample[], w: Window) =>
  list.filter(([at]) => at >= w.from && at <= w.to).map(([, l]) => l);

type ServerSample = {
  ts: number;
  rssBytes: number;
  heapUsedBytes: number;
  loopLagMaxMs: number;
  loopLagP99Ms: number;
};
const serverSamples: ServerSample[] = existsSync(statsFile)
  ? readFileSync(statsFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  : [];
const serverIn = (w: Window) => {
  const list = serverSamples.filter(
    (s) => s.ts >= w.from && s.ts <= w.to + 1_000,
  );
  const max = (k: keyof ServerSample) =>
    list.length ? Math.max(...list.map((s) => s[k])) : 0;
  return {
    rssMbMax: round(max("rssBytes") / 2 ** 20),
    heapMbMax: round(max("heapUsedBytes") / 2 ** 20),
    loopLagP99MsMax: round(max("loopLagP99Ms")),
    loopLagMaxMs: round(max("loopLagMaxMs")),
  };
};

const report = windows.map((w) => ({
  ...w,
  secs: round((w.to - w.from) / 1_000),
  trades: distribution(inWindow(samples.trades, w)),
  prices: distribution(inWindow(samples.prices, w)),
  server: serverIn(w),
}));

const d = (x: Distribution) =>
  `${round(x.p50)} / ${round(x.p95)} / ${round(x.p99)} / ${round(x.max)}`;
const md = [
  `# Export load (${new Date().toISOString()})`,
  "",
  `export table \`${table}\`${table === "trades" ? "" : ` (${tableSize.toLocaleString()} rows)`}, trades capacity ${rows.toLocaleString()} (full after ${fillSecs.toFixed(0)}s), tick x${tick}, ${clients} latency sessions, export filter \`${filter}\``,
  "",
  "## Latency on other sessions (ms, p50 / p95 / p99 / max)",
  "",
  mdTable(
    [
      "window",
      "secs",
      "trades e2e",
      "prices e2e",
      "server RSS / heap MB",
      "loop lag p99 / max ms",
    ],
    report.map((r) => [
      r.name,
      r.secs,
      d(r.trades),
      d(r.prices),
      `${r.server.rssMbMax} / ${r.server.heapMbMax}`,
      `${r.server.loopLagP99MsMax} / ${r.server.loopLagMaxMs}`,
    ]),
  ),
  "",
  "## Exports (client)",
  "",
  mdTable(
    [
      "mode",
      "rows",
      "total s",
      "first byte ms",
      "wire MB",
      "csv MB",
      "client peak RSS MB",
      "own-session trades p95 / max ms",
    ],
    report.flatMap((r) =>
      (r.exports ?? []).map((e) => [
        String(e.mode),
        Number(e.rows).toLocaleString(),
        round(Number(e.totalMs) / 1_000, 2),
        e.firstByteMs === undefined ? "–" : round(Number(e.firstByteMs)),
        round(Number(e.wireMB)),
        e.csvMB === undefined ? "–" : round(Number(e.csvMB)),
        round(Number(e.peakRssMB)),
        `${e.ownTradeLatencyP95 ?? "–"} / ${e.ownTradeLatencyMax ?? "–"}`,
      ]),
    ),
  ),
  "",
  "## Exports (server log)",
  "",
  "```",
  ...serverExports.map((e) => JSON.stringify(e)),
  "```",
].join("\n");

writeFileSync(
  `${out}.json`,
  JSON.stringify({ args, env, fillSecs, report, serverExports }, null, 2),
);
writeFileSync(`${out}.md`, md);
console.log(`\n${md}\n\nwrote ${out}.md`);
process.exit(0);
