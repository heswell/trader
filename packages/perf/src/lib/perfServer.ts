/** Launch the local perf trading server (src/perf-server.ts) on free ports. */
import { resolve } from "node:path";
import type { Subprocess } from "bun";
import { freePort } from "./util";

export interface PerfServer {
  process: Subprocess;
  wsUrl: string;
  authUrl: string;
  stop(): Promise<void>;
}

export async function startPerfServer(
  options: {
    /** EXCHANGE_SIM_* / OMS_* overrides. */
    env?: Record<string, string>;
    statsFile?: string;
    corsOrigins?: string[];
    wsPort?: number;
    httpPort?: number;
  } = {},
): Promise<PerfServer> {
  const wsPort = options.wsPort ?? (await freePort());
  const httpPort = options.httpPort ?? (await freePort());
  const server = Bun.spawn(
    ["bun", resolve(import.meta.dir, "../perf-server.ts")],
    {
      env: {
        ...process.env,
        ...options.env,
        VUU_WEBSOCKET_PORT: String(wsPort),
        VUU_HTTPS_PORT: String(httpPort),
        ...(options.statsFile
          ? { TRADER_PERF_STATS_FILE: options.statsFile }
          : {}),
        ...(options.corsOrigins
          ? { VUU_CORS_ALLOWED_ORIGINS: options.corsOrigins.join(",") }
          : {}),
      },
      stdout: "pipe",
      stderr: "inherit",
    },
  );
  const stop = async () => {
    server.kill();
    const exited = await Promise.race([
      server.exited.then(() => true),
      Bun.sleep(5_000).then(() => false),
    ]);
    if (!exited) server.kill(9);
  };
  const reader = server.stdout.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + 30_000;
  while (!text.includes("perf-server ready")) {
    if (Date.now() > deadline) {
      await stop();
      throw Error("perf server did not start");
    }
    const { value, done } = await reader.read();
    if (done) throw Error(`perf server exited: ${text}`);
    text += decoder.decode(value);
  }
  // keep draining so server logging never blocks on a full pipe
  void (async () => {
    while (!(await reader.read()).done) {}
  })();
  return {
    process: server,
    wsUrl: `ws://localhost:${wsPort}/websocket-trading`,
    authUrl: `http://localhost:${httpPort}/api/authn`,
    stop,
  };
}
