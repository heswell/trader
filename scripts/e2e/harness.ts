/**
 * Shared helpers for the opt-in e2e scripts (scripts/e2e/*.ts): port
 * selection, the processes a script owns (stopped on exit), waits, checks,
 * starting the stack (Keycloak via `start-all --keycloak-only`, then the
 * portal / trading / features / host servers) and the Keycloak login.
 */
import { connect } from "node:net";
import { resolve } from "node:path";
import type { Page } from "playwright";
import { stackConfig } from "../stack/config";

export const root = resolve(import.meta.dir, "../..");
export const argv = process.argv.slice(2);
export const flag = (name: string) => argv.includes(`--${name}`);
export const option = (name: string, fallback: number) => {
  const arg = argv.find((a) => a.startsWith(`--${name}=`));
  return arg ? Number(arg.split("=")[1]) : fallback;
};

let tag = "e2e";
/** Log prefix, e.g. "e2e persistence". */
export const setLogTag = (value: string) => {
  tag = value;
};

export const log = (msg: string) =>
  console.log(`[${tag} ${new Date().toISOString().slice(11, 19)}] ${msg}`);

export const portOpen = (port: number, host = "localhost") =>
  new Promise<boolean>((done) => {
    const socket = connect({ host, port });
    socket.setTimeout(1000);
    socket.once("connect", () => {
      socket.destroy();
      done(true);
    });
    socket.once("error", () => done(false));
    socket.once("timeout", () => {
      socket.destroy();
      done(false);
    });
  });

export const PORT_VARS: [string, number][] = [
  ["TRADER_PORTAL_WS_PORT", 8191],
  ["TRADER_PORTAL_HTTPS_PORT", 8543],
  ["TRADER_TRADING_WS_PORT", 8192],
  ["TRADER_TRADING_HTTPS_PORT", 8544],
  ["TRADER_HOST_PORT", 5100],
  ["TRADER_FEATURES_PORT", 5110],
];

/** Default ports if all free, else every server port shifted by the offset. */
export const choosePorts = async () => {
  const env: Record<string, string> = {};
  if (PORT_VARS.some(([name]) => process.env[name])) return env;
  const busy = [];
  for (const [, port] of PORT_VARS) if (await portOpen(port)) busy.push(port);
  if (!busy.length) return env;
  const offset = Number(process.env.E2E_PORT_OFFSET ?? 30);
  log(`ports ${busy.join(", ")} in use: shifting the stack by +${offset}`);
  for (const [name, port] of PORT_VARS) {
    if (await portOpen(port + offset))
      throw Error(`port ${port + offset} is in use too: set E2E_PORT_OFFSET`);
    env[name] = String(port + offset);
  }
  return env;
};

// ---- processes we own ------------------------------------------------------
export type Proc = ReturnType<typeof Bun.spawn>;
export const owned = new Set<Proc>();
export const output: Record<string, string[]> = {};

export const spawn = (
  name: string,
  cmd: string[],
  extraEnv: Record<string, string> = {},
) => {
  const proc = Bun.spawn(cmd, {
    cwd: root,
    env: { ...process.env, ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
  owned.add(proc);
  proc.exited.then(() => owned.delete(proc));
  output[name] ??= [];
  const lines = output[name];
  const pipe = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>)
      for (const line of decoder.decode(chunk).split("\n"))
        if (line.trim()) {
          lines.push(line);
          if (process.env.E2E_VERBOSE) console.log(`[${name}] ${line}`);
        }
  };
  pipe(proc.stdout as ReadableStream<Uint8Array>);
  pipe(proc.stderr as ReadableStream<Uint8Array>);
  return proc;
};

export const stop = async (
  proc: Proc,
  signal: "SIGTERM" | "SIGKILL" = "SIGTERM",
) => {
  proc.kill(signal);
  const done = await Promise.race([
    proc.exited.then(() => true),
    Bun.sleep(15_000).then(() => false),
  ]);
  if (!done) proc.kill("SIGKILL");
  await proc.exited;
};

export const cleanup = () => Promise.all([...owned].map((p) => stop(p)));
process.on("SIGINT", () => cleanup().then(() => process.exit(130)));
process.on("SIGTERM", () => cleanup().then(() => process.exit(143)));

/** Resolves with the time taken, or -1 on timeout. */
export const waitUntil = async (
  probe: () => Promise<boolean> | boolean,
  timeoutMs = 120_000,
) => {
  const started = Date.now();
  while (!(await probe())) {
    if (Date.now() - started > timeoutMs) return -1;
    await Bun.sleep(250);
  }
  return Date.now() - started;
};
export const mustWait = async (
  what: string,
  probe: () => Promise<boolean> | boolean,
  timeoutMs?: number,
) => {
  if ((await waitUntil(probe, timeoutMs)) < 0) throw Error(`${what}: timeout`);
};

// ---- checks ----------------------------------------------------------------
export const failures: string[] = [];
export const check = (ok: boolean, what: string) => {
  log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

/** The nav footer's PortalConnectionStatus (worst of all connections). */
export const CONNECTION_STATUS_SELECTOR =
  ".vuuPortalNav-footer .vuuPortalConnectionStatus";

/** PortalConnectionStatus `data-severity` as the e2e connection states. */
const SEVERITY_STATE: Record<string, string> = {
  ok: "connected",
  warning: "reconnecting",
  error: "disconnected",
  unknown: "connecting",
};

/** The nav connection status: connected / reconnecting / disconnected / connecting. */
export const indicatorState = (page: Page) =>
  page
    .locator(CONNECTION_STATUS_SELECTOR)
    .getAttribute("data-severity", { timeout: 2_000 })
    .then((severity) =>
      severity ? (SEVERITY_STATE[severity] ?? severity) : null,
    )
    .catch(() => null);

/** The host's error page text if a remote module failed to load. */
export const moduleError = (page: Page) =>
  page.evaluate(() =>
    document.body.textContent?.includes(
      "An error occurred while creating the remote module",
    )
      ? document.body.textContent.slice(0, 300)
      : undefined,
  );

// ---- stack -------------------------------------------------------------------
/**
 * Prepares (builds unless --no-build) and starts Keycloak plus the portal,
 * trading, features and host servers. `tradingEnv` is passed to every trading
 * server start.
 */
export const startStack = async (tradingEnv: Record<string, string> = {}) => {
  Object.assign(process.env, await choosePorts());
  const cfg = stackConfig();

  log(`preparing${flag("no-build") ? "" : " (building host + features)"}`);
  const prepare = Bun.spawnSync(
    [
      "bun",
      "./scripts/start-all.ts",
      "--prepare",
      ...(flag("no-build") ? [] : ["--build"]),
    ],
    { cwd: root, env: process.env, stdout: "ignore", stderr: "inherit" },
  );
  if (prepare.exitCode !== 0) throw Error("start-all --prepare failed");

  const keycloak = spawn("keycloak", [
    "bun",
    "./scripts/start-all.ts",
    "--keycloak-only",
  ]);
  await mustWait(
    "keycloak",
    () => {
      if (keycloak.exitCode !== null)
        throw Error(
          `keycloak exited:\n${output.keycloak.slice(-20).join("\n")}`,
        );
      return output.keycloak.some((l) => l.includes("ready: keycloak only"));
    },
    240_000,
  );
  log(`keycloak ready at ${cfg.keycloakUrl}`);

  const startTrading = (extraEnv?: Record<string, string>) =>
    spawn("trading", ["bun", "./scripts/stack/serve.ts", "trading"], {
      ...tradingEnv,
      ...extraEnv,
    });
  const startPortal = () =>
    spawn("portal", ["bun", "./scripts/stack/serve.ts", "portal"]);
  const portal = startPortal();
  const trading = startTrading();
  spawn("features", ["bun", "./scripts/stack/serve.ts", "features"]);
  spawn("host", ["bun", "./scripts/stack/serve.ts", "host"]);
  for (const port of [
    cfg.portalWsPort,
    cfg.tradingWsPort,
    cfg.hostPort,
    cfg.featuresPort,
  ])
    await mustWait(`port ${port}`, () => portOpen(port));
  log(`stack up: ${cfg.hostOrigin}`);
  return { cfg, portal, trading, startPortal, startTrading };
};

/** Keycloak login form (the host redirects there on first load). */
export const login = async (page: Page, user = "alice") => {
  await page.locator("#username").fill(user);
  await page.locator("#password").fill("password");
  await page.locator("#kc-login").click();
};

/** Runs `main`, reports the checks, stops everything owned, exits. */
export const run = async (main: () => Promise<void>) => {
  let code = 0;
  try {
    await main();
    code = failures.length ? 1 : 0;
    log(
      failures.length
        ? `${failures.length} check(s) failed:\n  ${failures.join("\n  ")}`
        : "all checks passed",
    );
  } catch (error) {
    log(`error: ${(error as Error).message}`);
    code = 1;
  } finally {
    log("stopping the stack");
    await cleanup();
  }
  process.exit(code);
};
