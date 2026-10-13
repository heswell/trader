/**
 * Exchange simulator benchmark.
 *
 *   bun run --cwd packages/exchange-sim bench [--mode=max|realtime|both]
 *     [--seconds=10] [--subscribe]
 *
 * Config comes from EXCHANGE_SIM_* env vars (defaults otherwise), e.g.
 *   EXCHANGE_SIM_ACTIVE_INSTRUMENTS=300 EXCHANGE_SIM_TAKER_RATE=20 bun run bench
 *
 * Both modes run the simulator inside a real VuuServer so table updates go
 * through vuu-table (indices, viewport notification), not fakes.
 *
 * - max:      ManualClock, steps/flushes as fast as possible. Reports book
 *             events and table updates per *wall* second (capacity) and the
 *             simulated-time / wall-time ratio (headroom; >1 means the
 *             default load fits in real time).
 * - realtime: Real timers for --seconds. Reports achieved rates and
 *             event-loop lag. --subscribe adds a websocket client with
 *             viewports on prices, depth and trades (rows 0..500).
 */
import { EXCHANGE_MODULE } from "@heswell/trading-schemas";
import {
  LifecycleContainer,
  LoginTokenService,
  setLogLevel,
  VuuServer,
  VuuServerConfig,
  VuuUserWithAuthorizations,
  VuuWebSocketOptions,
} from "@heswell/vuu-server";
import { loadExchangeSimConfig } from "../src/config";
import { ExchangeSimulator } from "../src/engine/ExchangeSimulator";
import { ExchangeModule } from "../src/modules/exchange/ExchangeModule";
import type { MarketDataPublisher } from "../src/publish/MarketDataPublisher";
import { ManualClock } from "../src/util/clock";

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value = "true"] = arg.replace(/^--/, "").split("=");
    return [key, value];
  }),
);
const mode = args.mode ?? "both";
const seconds = Number(args.seconds ?? 10);
const subscribe = args.subscribe === "true";

// keep server startup chatter out of the report; VUU_LOG_LEVEL=info shows it
if (!process.env.VUU_LOG_LEVEL) setLogLevel("warn");

const startServer = async (sim: ExchangeSimulator, autoStart: boolean) => {
  const lifecycle = new LifecycleContainer();
  const tokens = LoginTokenService();
  const server = new VuuServer(
    VuuServerConfig(
      VuuWebSocketOptions().withWsPort(0).withSslDisabled(),
      {},
      tokens,
    ).withModule(ExchangeModule(sim, { autoStart })),
    lifecycle,
  );
  await lifecycle.start();
  return { lifecycle, server, tokens };
};

const tableUpdates = (publisher: MarketDataPublisher | undefined) => {
  if (!publisher) return 0;
  const { priceUpdates, depthUpdates, tradeInserts, tradeEvictions } =
    publisher.stats;
  return priceUpdates + depthUpdates + tradeInserts + tradeEvictions;
};

const fmt = (n: number) => Math.round(n).toLocaleString("en-GB");

const describeConfig = (sim: ExchangeSimulator) => {
  const c = sim.config;
  return `${sim.books.length} books, mm ${c.mmPerInstrument}x${c.mmLevels} levels @ ${c.mmRate}/s, taker ${c.takerRate}/s, step ${c.botStepMs}ms, flush ${c.publishIntervalMs}ms, timeScale ${c.timeScale}`;
};

async function benchMax() {
  const clock = new ManualClock();
  const config = loadExchangeSimConfig(undefined, process.env);
  const sim = new ExchangeSimulator({ config, clock: clock.now });
  const { lifecycle } = await startServer(sim, false);
  console.log(`\n[max] ${describeConfig(sim)}`);

  const flushEvery = Math.max(
    1,
    Math.round(config.publishIntervalMs / config.botStepMs),
  );
  const run = (simSeconds: number) => {
    const steps = Math.round((simSeconds * 1000) / config.botStepMs);
    for (let i = 1; i <= steps; i++) {
      sim.step(clock.advance(config.botStepMs));
      if (i % flushEvery === 0) sim.flush(clock.time);
    }
  };
  run(2); // warm-up

  const events0 = sim.bookEvents;
  const trades0 = sim.tradeCount;
  const updates0 = tableUpdates(sim.publisher);
  const simSeconds = Math.max(seconds, 5);
  const t0 = performance.now();
  run(simSeconds);
  const wall = (performance.now() - t0) / 1000;
  const events = sim.bookEvents - events0;
  const trades = sim.tradeCount - trades0;
  const updates = tableUpdates(sim.publisher) - updates0;

  console.log(
    `[max] simulated ${simSeconds}s in ${wall.toFixed(2)}s wall (headroom x${(simSeconds / wall).toFixed(1)})`,
  );
  console.log(
    `[max] per simulated second: ${fmt(events / simSeconds)} book events, ${fmt(trades / simSeconds)} trades, ${fmt(updates / simSeconds)} table updates`,
  );
  console.log(
    `[max] capacity per wall second: ${fmt(events / wall)} book events/s, ${fmt(updates / wall)} table updates/s`,
  );
  console.log(`[max] deferred steps (maxOpsPerStep): ${sim.deferredSteps}`);
  await lifecycle.destroy();
}

async function benchRealtime() {
  const config = loadExchangeSimConfig(undefined, process.env);
  const sim = new ExchangeSimulator({ config });
  const { lifecycle, server, tokens } = await startServer(sim, true);
  console.log(
    `\n[realtime] ${describeConfig(sim)}${subscribe ? ", ws subscriber" : ""}`,
  );

  let received = 0;
  let socket: WebSocket | undefined;
  if (subscribe) {
    socket = await subscriber(
      server.webSocketPort as number,
      tokens.getToken(VuuUserWithAuthorizations("bench", [])),
      () => received++,
    );
  }

  await Bun.sleep(1_000); // warm-up
  const events0 = sim.bookEvents;
  const trades0 = sim.tradeCount;
  const updates0 = tableUpdates(sim.publisher);
  const received0 = received;
  const lags: number[] = [];
  let expected = performance.now() + 10;
  const lagTimer = setInterval(() => {
    const now = performance.now();
    lags.push(Math.max(0, now - expected));
    expected = now + 10;
  }, 10);
  const t0 = performance.now();
  await Bun.sleep(seconds * 1_000);
  clearInterval(lagTimer);
  const wall = (performance.now() - t0) / 1000;

  lags.sort((a, b) => a - b);
  const pct = (p: number) => lags[Math.floor((lags.length - 1) * p)] ?? 0;
  console.log(
    `[realtime] ${fmt((sim.bookEvents - events0) / wall)} book events/s, ${fmt((sim.tradeCount - trades0) / wall)} trades/s, ${fmt((tableUpdates(sim.publisher) - updates0) / wall)} table updates/s`,
  );
  if (subscribe) {
    console.log(
      `[realtime] ws client received ${fmt((received - received0) / wall)} row updates/s`,
    );
  }
  console.log(
    `[realtime] event-loop lag p50 ${pct(0.5).toFixed(1)}ms p99 ${pct(0.99).toFixed(1)}ms max ${pct(1).toFixed(1)}ms; deferred steps ${sim.deferredSteps}`,
  );
  socket?.close();
  await lifecycle.destroy();
}

async function subscriber(port: number, token: string, onRow: () => void) {
  const socket = new WebSocket(`ws://localhost:${port}/websocket`);
  await new Promise((resolve) => socket.addEventListener("open", resolve));
  const sessionId = await new Promise<string>((resolve) => {
    socket.addEventListener("message", ({ data }) => {
      const message = JSON.parse(String(data));
      if (message.body.type === "LOGIN_SUCCESS") resolve(message.sessionId);
      if (message.body.type === "TABLE_ROW") {
        for (const row of message.body.rows)
          if (row.updateType === "U") onRow();
      }
    });
    socket.send(
      JSON.stringify({
        body: { token, type: "LOGIN" },
        module: "CORE",
        requestId: "login",
        sessionId: "",
      }),
    );
  });
  const viewports: Record<string, string[]> = {
    prices: ["ric", "bid", "ask", "bidSize", "askSize", "last", "volume"],
    depth: ["id", "ric", "side", "level", "price", "size", "cumSize"],
    trades: ["tradeId", "ric", "price", "size", "timestamp"],
  };
  for (const [table, columns] of Object.entries(viewports)) {
    socket.send(
      JSON.stringify({
        body: {
          aggregations: [],
          columns,
          filterSpec: { filter: "" },
          groupBy: [],
          range: { from: 0, to: 500 },
          sort: { sortDefs: [] },
          table: { module: EXCHANGE_MODULE, table },
          type: "CREATE_VP",
        },
        module: EXCHANGE_MODULE,
        requestId: `vp-${table}`,
        sessionId,
      }),
    );
  }
  return socket;
}

if (mode === "max" || mode === "both") await benchMax();
if (mode === "realtime" || mode === "both") await benchRealtime();
process.exit(0);
