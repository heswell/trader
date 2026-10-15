/**
 * End-to-end WS throughput test: N headless Vuu clients x M viewports on the
 * ticking trading tables, against a local perf server or the start:all stack.
 *
 *   bun run perf:ws [--preset=smoke|heavy] [--target=local|stack]
 *     [--clients=N] [--viewports=M] [--duration=s] [--warmup=s]
 *     [--tick=x] [--mm-rate=n] [--taker-rate=n] [--publish-ms=n]
 *     [--active=n] [--workers=n] [--assert]
 *
 * See docs/performance.md. Writes perf-results/ws-load-<stamp>.{json,md}.
 */
import { cpus } from "node:os";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Subprocess } from "bun";
import { stackConfig } from "../../../scripts/stack/config";
import { keycloakLogin } from "./lib/keycloakLogin";
import { startPerfServer } from "./lib/perfServer";
import {
  type Distribution,
  distribution,
  fmt,
  mdTable,
  parseArgs,
  resultsPath,
  round,
  sleep,
} from "./lib/util";
import { type ViewportSpec, VuuPerfClient } from "./lib/vuuPerfClient";
import type {
  ClientResult,
  WorkerClientSpec,
  WorkerMessage,
} from "./ws-load-worker";

interface Preset {
  clients: number;
  viewports: number;
  duration: number;
  warmup: number;
  /** Multiplier on the default bot rates (mmRate 10, takerRate 8). */
  tick: number;
}

const PRESETS: Record<string, Preset> = {
  /** CI-friendly: ~20s end to end. */
  smoke: { clients: 5, viewports: 5, duration: 10, warmup: 3, tick: 1 },
  /** Local only: 50 sessions, 8 viewports each, 4x the default tick rate. */
  heavy: { clients: 50, viewports: 8, duration: 30, warmup: 5, tick: 4 },
};

/** Viewport kinds, cycled per client (client i starts at offset i). */
const KINDS = [
  "instrumentPrices",
  "ladder",
  "parentOrders",
  "prices",
  "childOrders",
  "trades",
  "positionPrices",
  "ladder",
  "fills",
  "ladder",
] as const;
type Kind = (typeof KINDS)[number];

const TABLES: Record<Kind, { module: string; table: string }> = {
  instrumentPrices: { module: "EXCHANGE", table: "instrumentPrices" },
  prices: { module: "EXCHANGE", table: "prices" },
  ladder: { module: "EXCHANGE", table: "depth" },
  trades: { module: "EXCHANGE", table: "trades" },
  parentOrders: { module: "OMS", table: "parentOrders" },
  childOrders: { module: "OMS", table: "childOrders" },
  positionPrices: { module: "OMS", table: "positionPrices" },
  fills: { module: "OMS", table: "fills" },
};

/** start:all users with a trading role (password "password"). */
const STACK_USERS = ["alice", "bob", "carol", "erin", "sam", "dave"];

const args = parseArgs();
const presetName = args.preset ?? "smoke";
const preset = PRESETS[presetName];
if (!preset) throw Error(`unknown preset ${presetName}`);
const num = (key: string, fallback: number) =>
  args[key] === undefined ? fallback : Number(args[key]);
const target = args.target ?? "local";
const clientsN = num("clients", preset.clients);
const viewportsM = num("viewports", preset.viewports);
const duration = num("duration", preset.duration);
const warmup = num("warmup", preset.warmup);
const tick = num("tick", preset.tick);
const workersN = num(
  "workers",
  Math.max(1, Math.min(clientsN, Math.floor(cpus().length / 2))),
);
const assert = args.assert === "true";
const p95Budget = num("max-p95-ms", 1_000);

const simEnv: Record<string, string> = {
  EXCHANGE_SIM_MM_RATE: String(num("mm-rate", 10 * tick)),
  EXCHANGE_SIM_TAKER_RATE: String(num("taker-rate", 8 * tick)),
  ...(args["publish-ms"]
    ? { EXCHANGE_SIM_PUBLISH_INTERVAL_MS: args["publish-ms"] }
    : {}),
  ...(args.active ? { EXCHANGE_SIM_ACTIVE_INSTRUMENTS: args.active } : {}),
};

const out = resultsPath(`ws-load-${presetName}`);
const children: Subprocess[] = [];
/** Stop the children (graceful, then SIGKILL after 5s). */
const cleanup = async () => {
  for (const child of children) child.kill();
  await Promise.race([
    Promise.all(children.map((child) => child.exited)),
    sleep(5_000),
  ]);
  for (const child of children) if (child.exitCode === null) child.kill(9);
};
process.on("SIGINT", async () => {
  await cleanup();
  process.exit(130);
});

// ---------------------------------------------------------------- server

interface Endpoint {
  wsUrl: string;
  insecure: boolean;
  serverPid?: number;
  statsFile?: string;
  /** Vuu token per client index. */
  token(i: number): Promise<string>;
  maxClients: number;
}

async function startLocal(): Promise<Endpoint> {
  const statsFile = `${out}-server.jsonl`;
  const server = await startPerfServer({ env: simEnv, statsFile });
  children.push(server.process);
  return {
    wsUrl: server.wsUrl,
    insecure: false,
    serverPid: server.process.pid,
    statsFile,
    maxClients: Number.POSITIVE_INFINITY,
    // one user per client: the per-user session limit never applies
    token: (i) =>
      VuuPerfClient.fetchToken(server.authUrl, { username: `perf-${i}` }),
  };
}

async function connectStack(): Promise<Endpoint> {
  const cfg = stackConfig();
  const users = args.users?.split(",") ?? STACK_USERS;
  // leave one of maxSessionsPerUser=5 (reject-new) free for a browser tab
  const perUser = num("sessions-per-user", 4);
  const restUrl = `https://${cfg.host}:${cfg.tradingHttpsPort}/api/authn`;
  const tokens = new Map<string, Promise<string>>();
  const userToken = (user: string) => {
    let token = tokens.get(user);
    if (!token) {
      token = keycloakLogin({
        keycloakUrl: cfg.keycloakUrl,
        realm: cfg.keycloakRealm,
        clientId: "vuu-portal",
        redirectUri: `${cfg.hostOrigin}/`,
        username: user,
        password: "password",
      }).then((bearer) =>
        VuuPerfClient.fetchToken(restUrl, { bearer }, { insecure: true }),
      );
      tokens.set(user, token);
    }
    return token;
  };
  const pid = Bun.spawnSync([
    "lsof",
    "-nP",
    "-t",
    `-iTCP:${cfg.tradingWsPort}`,
    "-sTCP:LISTEN",
  ])
    .stdout.toString()
    .trim()
    .split("\n")[0];
  const statsFile = args["stats-file"];
  return {
    wsUrl: `wss://${cfg.host}:${cfg.tradingWsPort}/websocket-trading`,
    insecure: true,
    serverPid: pid ? Number(pid) : undefined,
    statsFile: statsFile && existsSync(statsFile) ? statsFile : undefined,
    maxClients: users.length * perUser,
    token: (i) => userToken(users[i % users.length]),
  };
}

// ---------------------------------------------------------------- viewports

async function probe(endpoint: Endpoint) {
  // the probe uses client 0's user; it closes before the load clients log in
  const client = await VuuPerfClient.login(
    endpoint.wsUrl,
    await endpoint.token(0),
    { insecure: endpoint.insecure },
  );
  const columns = {} as Record<Kind, string[]>;
  for (const kind of new Set(KINDS)) {
    const { module, table } = TABLES[kind];
    columns[kind] = await client.tableColumns(module, table);
  }
  const rics = new Set<string>();
  const stop = client.listen((body) => {
    if (body.type !== "TABLE_ROW") return;
    for (const row of body.rows)
      if (row.updateType === "U") rics.add(row.rowKey);
  });
  await client.createViewport({
    kind: "probe",
    module: "EXCHANGE",
    table: "prices",
    columns: ["ric", "bid"],
    range: { from: 0, to: 2_000 },
  });
  await sleep(1_500);
  stop();
  client.close();
  await sleep(250);
  if (rics.size === 0) throw Error("probe: no prices rows");
  return { columns, rics: [...rics].sort() };
}

const viewportSpec = (
  kind: Kind,
  columns: Record<Kind, string[]>,
  rics: string[],
  n: number,
): ViewportSpec => {
  const { module, table } = TABLES[kind];
  const spec: ViewportSpec = {
    kind,
    module,
    table,
    columns: columns[kind],
    range: { from: 0, to: 100 },
  };
  switch (kind) {
    case "instrumentPrices":
      return { ...spec, timestampColumn: "timestamp" };
    case "prices":
      // every row in range: rows received vs server updates = coalescing
      return {
        ...spec,
        range: { from: 0, to: rics.length },
        timestampColumn: "timestamp",
        seqColumn: "seq",
      };
    case "ladder":
      return {
        ...spec,
        filter: `ric = "${rics[n % rics.length]}" and level < 10`,
        range: { from: 0, to: 40 },
      };
    case "parentOrders":
    case "childOrders":
      return { ...spec, timestampColumn: "lastUpdate" };
    case "trades":
      // newest first, like the trades blotter (the tape appends at the end)
      return {
        ...spec,
        sort: [{ column: "timestamp", sortType: "D" }],
        timestampColumn: "timestamp",
      };
    default:
      return spec;
  }
};

// ---------------------------------------------------------------- server stats

interface ServerSample {
  ts: number;
  cpuUserUs: number;
  cpuSystemUs: number;
  rssBytes: number;
  heapUsedBytes: number;
  loopLagMaxMs: number;
  loopLagP99Ms: number;
  bookEvents: number;
  trades: number;
  deferredSteps: number;
  priceUpdates: number;
  depthUpdates: number;
  tradeInserts: number;
  omsWrites: Record<string, number>;
}

const readServerStats = (file: string, from: number, to: number) => {
  const samples = readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ServerSample)
    .filter((s) => s.ts >= from - 1_100 && s.ts <= to + 100);
  if (samples.length < 2) return undefined;
  const a = samples[0];
  const b = samples.at(-1) as ServerSample;
  const secs = (b.ts - a.ts) / 1_000;
  const rate = (key: keyof ServerSample) =>
    ((b[key] as number) - (a[key] as number)) / secs;
  const omsWrites =
    Object.values(b.omsWrites).reduce((t, v) => t + v, 0) -
    Object.values(a.omsWrites).reduce((t, v) => t + v, 0);
  const inWindow = samples.slice(1);
  return {
    windowSecs: round(secs, 2),
    cpuPct: round(
      (100 * (b.cpuUserUs + b.cpuSystemUs - a.cpuUserUs - a.cpuSystemUs)) /
        1_000 /
        (b.ts - a.ts),
    ),
    rssMbMax: round(Math.max(...inWindow.map((s) => s.rssBytes)) / 2 ** 20),
    heapMbMax: round(
      Math.max(...inWindow.map((s) => s.heapUsedBytes)) / 2 ** 20,
    ),
    loopLagP99MsMax: round(Math.max(...inWindow.map((s) => s.loopLagP99Ms))),
    loopLagMaxMs: round(Math.max(...inWindow.map((s) => s.loopLagMaxMs))),
    bookEventsPerSec: round(rate("bookEvents")),
    tradesPerSec: round(rate("trades")),
    deferredSteps: b.deferredSteps - a.deferredSteps,
    priceUpdatesPerSec: round(rate("priceUpdates")),
    depthUpdatesPerSec: round(rate("depthUpdates")),
    tradeInsertsPerSec: round(rate("tradeInserts")),
    omsWritesPerSec: round(omsWrites / secs),
  };
};

/** `ps` samples of the server process (works for any target). */
const psSampler = (pid: number | undefined) => {
  const samples: { cpu: number; rssKb: number }[] = [];
  if (!pid) return { samples, stop: () => {} };
  const timer = setInterval(() => {
    const [cpu, rss] = Bun.spawnSync([
      "ps",
      "-o",
      "%cpu=,rss=",
      "-p",
      String(pid),
    ])
      .stdout.toString()
      .trim()
      .split(/\s+/)
      .map(Number);
    if (Number.isFinite(cpu)) samples.push({ cpu, rssKb: rss });
  }, 1_000);
  return { samples, stop: () => clearInterval(timer) };
};

// ---------------------------------------------------------------- run

async function main() {
  console.log(
    `ws-load ${presetName}: ${clientsN} clients x ${viewportsM} viewports, ${target}, ${duration}s (+${warmup}s warmup), tick x${tick}, ${workersN} workers`,
  );
  const endpoint =
    target === "stack" ? await connectStack() : await startLocal();
  if (clientsN > endpoint.maxClients) {
    throw Error(
      `${clientsN} clients exceed ${endpoint.maxClients} sessions available on the stack (users x sessions-per-user); use --users / --sessions-per-user or --target=local`,
    );
  }
  const { columns, rics } = await probe(endpoint);

  const specs: WorkerClientSpec[] = [];
  for (let i = 0; i < clientsN; i++) {
    specs.push({
      id: `client-${i}`,
      token: await endpoint.token(i),
      viewports: Array.from({ length: viewportsM }, (_, k) =>
        viewportSpec(
          KINDS[(i + k) % KINDS.length],
          columns,
          rics,
          i * viewportsM + k,
        ),
      ),
    });
  }

  const results: Extract<WorkerMessage, { type: "result" }>[] = [];
  const errors: string[] = [];
  let ready = 0;
  const workerFile = resolve(import.meta.dir, "ws-load-worker.ts");
  const workers = Array.from({ length: workersN }, (_, w) => {
    const worker = Bun.spawn(["bun", workerFile], {
      stdio: ["ignore", "inherit", "inherit"],
      ipc(message: WorkerMessage) {
        if (message.type === "ready") {
          ready++;
          errors.push(...message.errors);
        } else results.push(message);
      },
    });
    children.push(worker);
    worker.send({
      type: "init",
      wsUrl: endpoint.wsUrl,
      insecure: endpoint.insecure,
      clients: specs.filter((_, i) => i % workersN === w),
    });
    return worker;
  });
  const waitUntil = async (done: () => boolean, ms: number, what: string) => {
    const deadline = Date.now() + ms;
    while (!done()) {
      if (Date.now() > deadline) throw Error(`timed out: ${what}`);
      await sleep(50);
    }
  };
  await waitUntil(() => ready === workersN, 60_000, "clients ready");
  if (errors.length) console.warn(`client errors:\n  ${errors.join("\n  ")}`);
  await sleep(warmup * 1_000);

  const ps = psSampler(endpoint.serverPid);
  const startTs = Date.now();
  for (const worker of workers) worker.send({ type: "start" });
  await sleep(duration * 1_000);
  for (const worker of workers) worker.send({ type: "stop" });
  const endTs = Date.now();
  ps.stop();
  await waitUntil(() => results.length === workersN, 30_000, "results");
  for (const worker of workers) worker.send({ type: "exit" });
  // let the server write the sample after the window
  await sleep(1_200);

  const report = summarise({
    clients: results.flatMap((r) => r.clients),
    elapsedMs: Math.max(...results.map((r) => r.elapsedMs)),
    harnessCpuPct: round(
      (100 * results.reduce((t, r) => t + r.cpuMs, 0)) / (duration * 1_000),
    ),
    server: endpoint.statsFile
      ? readServerStats(endpoint.statsFile, startTs, endTs)
      : undefined,
    ps: ps.samples,
    errors,
    rics: rics.length,
  });
  await cleanup();

  writeFileSync(`${out}.json`, JSON.stringify(report, null, 2));
  const md = markdown(report);
  writeFileSync(`${out}.md`, md);
  console.log(`\n${md}\nwrote ${out}.json / .md`);

  if (assert) {
    const failures = check(report);
    if (failures.length) {
      console.error(`ASSERT FAILED:\n  ${failures.join("\n  ")}`);
      process.exit(1);
    }
    console.log("assertions passed");
  }
  process.exit(0);
}

// ---------------------------------------------------------------- report

interface KindSummary {
  viewports: number;
  rowsPerSec: number;
  rowsPerSecPerViewport: number;
  sizeOnlyPerSec: number;
  latencyMs?: Distribution;
  /** prices: book events skipped between consecutive updates of a ric. */
  seqGapPct?: number;
}

function summarise(input: {
  clients: ClientResult[];
  elapsedMs: number;
  harnessCpuPct: number;
  server: ReturnType<typeof readServerStats>;
  ps: { cpu: number; rssKb: number }[];
  errors: string[];
  rics: number;
}) {
  const secs = input.elapsedMs / 1_000;
  const byKind = new Map<string, ClientResult["viewports"]>();
  for (const client of input.clients) {
    for (const vp of client.viewports) {
      byKind.set(vp.kind, [...(byKind.get(vp.kind) ?? []), vp]);
    }
  }
  const kinds: Record<string, KindSummary> = {};
  for (const [kind, vps] of byKind) {
    const rows = vps.reduce((t, v) => t + v.rows, 0);
    const latency = vps.flatMap((v) => v.latency);
    const gaps = vps.reduce((t, v) => t + v.seqGaps, 0);
    const updates = vps.reduce((t, v) => t + v.seqUpdates, 0);
    kinds[kind] = {
      viewports: vps.length,
      rowsPerSec: round(rows / secs),
      rowsPerSecPerViewport: round(rows / secs / vps.length),
      sizeOnlyPerSec: round(vps.reduce((t, v) => t + v.sizeOnly, 0) / secs),
      ...(latency.length
        ? { latencyMs: roundDist(distribution(latency)) }
        : {}),
      ...(updates ? { seqGapPct: round((100 * gaps) / (gaps + updates)) } : {}),
    };
  }
  const totalRows = input.clients.reduce(
    (t, c) => t + c.viewports.reduce((s, v) => s + v.rows, 0),
    0,
  );
  const prices = kinds.prices;
  const serverPrices = input.server?.priceUpdatesPerSec;
  return {
    config: {
      preset: presetName,
      target,
      clients: clientsN,
      viewportsPerClient: viewportsM,
      durationSecs: duration,
      warmupSecs: warmup,
      tick,
      sim: simEnv,
      rics: input.rics,
      workers: workersN,
      host: { cpus: cpus().length, platform: process.platform },
      date: new Date().toISOString(),
    },
    clients: {
      connected: input.clients.length,
      disconnected: input.clients.filter((c) => c.closed).map((c) => c.id),
      errors: input.errors,
      rowsPerSec: round(totalRows / secs),
      messagesPerSec: round(
        input.clients.reduce((t, c) => t + c.messages, 0) / secs,
      ),
      mbPerSec: round(
        input.clients.reduce((t, c) => t + c.bytes, 0) / secs / 2 ** 20,
        2,
      ),
      wireLatencyMs: roundDist(
        distribution(input.clients.flatMap((c) => c.wireLatency)),
      ),
      harnessCpuPct: input.harnessCpuPct,
      byKind: kinds,
    },
    server: input.server,
    serverPs: input.ps.length
      ? {
          cpuPctMean: round(
            input.ps.reduce((t, s) => t + s.cpu, 0) / input.ps.length,
          ),
          cpuPctMax: round(Math.max(...input.ps.map((s) => s.cpu))),
          rssMbMax: round(Math.max(...input.ps.map((s) => s.rssKb)) / 1_024),
        }
      : undefined,
    coalescing:
      prices && serverPrices
        ? {
            /** 1 - prices rows received per full-coverage viewport / server price updates. */
            serverToClientPct: round(
              100 * (1 - prices.rowsPerSecPerViewport / serverPrices),
            ),
            /** 1 - price row updates / book events (publisher flush coalescing, by design). */
            publisherPct: input.server
              ? round(
                  100 *
                    (1 -
                      serverPrices /
                        Math.max(1, input.server.bookEventsPerSec)),
                )
              : undefined,
          }
        : undefined,
  };
}

const roundDist = (d: Distribution): Distribution => ({
  count: d.count,
  mean: round(d.mean),
  p50: round(d.p50),
  p95: round(d.p95),
  p99: round(d.p99),
  max: round(d.max),
});

type Report = ReturnType<typeof summarise>;

function markdown(r: Report) {
  const c = r.config;
  const lines = [
    `## WS load: ${c.preset} (${c.clients} clients x ${c.viewportsPerClient} viewports, ${c.target})`,
    "",
    `${c.date}, ${c.durationSecs}s window, tick x${c.tick} (${Object.entries(
      c.sim,
    )
      .map(([k, v]) => `${k}=${v}`)
      .join(
        " ",
      )}), ${c.rics} rics, host ${c.host.cpus} CPUs ${c.host.platform}`,
    "",
    `**Clients**: ${r.clients.connected} connected, ${r.clients.disconnected.length} disconnected, ${r.clients.errors.length} errors; ${fmt(r.clients.rowsPerSec)} rows/s, ${fmt(r.clients.messagesPerSec)} msgs/s, ${r.clients.mbPerSec} MB/s; wire latency (server send -> receipt) p50 ${r.clients.wireLatencyMs.p50} / p95 ${r.clients.wireLatencyMs.p95} / p99 ${r.clients.wireLatencyMs.p99} ms; harness CPU ${r.clients.harnessCpuPct}%`,
    "",
    mdTable(
      [
        "viewport",
        "count",
        "rows/s",
        "rows/s per vp",
        "e2e p50 ms",
        "e2e p95 ms",
        "e2e p99 ms",
      ],
      Object.entries(r.clients.byKind).map(([kind, k]) => [
        kind,
        k.viewports,
        fmt(k.rowsPerSec),
        fmt(k.rowsPerSecPerViewport, 1),
        k.latencyMs?.p50 ?? "-",
        k.latencyMs?.p95 ?? "-",
        k.latencyMs?.p99 ?? "-",
      ]),
    ),
    "",
  ];
  if (r.server) {
    const s = r.server;
    lines.push(
      `**Server** (stats file): CPU ${s.cpuPct}%, RSS max ${s.rssMbMax} MB, heap max ${s.heapMbMax} MB, event-loop lag p99 ${s.loopLagP99MsMax} ms (max ${s.loopLagMaxMs} ms); book events ${fmt(s.bookEventsPerSec)}/s, trades ${fmt(s.tradesPerSec)}/s, table updates: prices ${fmt(s.priceUpdatesPerSec)}/s, depth ${fmt(s.depthUpdatesPerSec)}/s, trades ${fmt(s.tradeInsertsPerSec)}/s, OMS ${fmt(s.omsWritesPerSec)}/s; deferred sim steps ${s.deferredSteps}`,
      "",
    );
  }
  if (r.serverPs) {
    lines.push(
      `**Server** (ps): CPU mean ${r.serverPs.cpuPctMean}% / max ${r.serverPs.cpuPctMax}%, RSS max ${r.serverPs.rssMbMax} MB`,
      "",
    );
  }
  if (r.coalescing) {
    lines.push(
      `**Coalescing**: server -> client ${r.coalescing.serverToClientPct}% of price updates not delivered individually (full-coverage prices viewports); publisher ${r.coalescing.publisherPct ?? "-"}% of book events folded into flushes (by design, publishIntervalMs)`,
      "",
    );
  }
  return lines.join("\n");
}

function check(r: Report) {
  const failures: string[] = [];
  if (r.clients.errors.length)
    failures.push(`${r.clients.errors.length} client errors`);
  if (r.clients.disconnected.length) {
    failures.push(`disconnected: ${r.clients.disconnected.join(", ")}`);
  }
  for (const kind of ["instrumentPrices", "prices", "ladder"]) {
    const k = r.clients.byKind[kind];
    if (k && k.rowsPerSec === 0) failures.push(`no ${kind} rows received`);
    if (k?.latencyMs && k.latencyMs.p95 > p95Budget) {
      failures.push(`${kind} e2e p95 ${k.latencyMs.p95}ms > ${p95Budget}ms`);
    }
  }
  return failures;
}

main().catch(async (error) => {
  console.error(error);
  await cleanup();
  process.exit(1);
});
