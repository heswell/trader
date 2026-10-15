/**
 * bun run start:all   (also `bun run dev`)
 *
 * Starts the whole trader stack with prefixed logs, waits until every part is
 * ready, prints the URLs / users, and stops everything it started on Ctrl-C:
 *
 *   keycloak  Keycloak (realm "vuu", trading roles, seeded users)    :8180
 *             - an already running one at TRADER_KEYCLOAK_URL is reused,
 *             - else a local install (KEYCLOAK_HOME, default ~/keycloak/keycloak-*)
 *               is started in dev mode with state under .run/keycloak,
 *             - or run `docker compose up keycloak` first.
 *   portal    vuu-portal server (module discovery, portal auth)      wss :8191, https :8543
 *   trading   trading Vuu server: exchange-sim + OMS                  wss :8192, https :8544
 *             (the trading remotes' config.json points at it)
 *   host      portal host (PortalShell)                              http :5100
 *   features  trading MF remotes, one per /<feature>/                 http :5110
 *
 * Ports: scripts/stack/config.ts (TRADER_* env vars). Busy ports are reported,
 * never taken over. Flags: --build (rebuild host + features first),
 * --reseed (reset the portal's runtime module list to the defaults),
 * --prepare (certs, builds and the generated portal module list only, then
 * exit: used by the Procfile), --keycloak-only (Keycloak + realm only, kept
 * running until stopped: used by scripts/e2e/resilience.ts, which runs and
 * restarts the servers itself).
 * The servers use the committed apps/portal-config/*.conf; TRADER_* settings
 * reach them as per-process VUU_* env vars (scripts/stack/config.ts serverEnv).
 * TRADER_TRADING_CLIENT_SECRET overrides the trading server's Keycloak client
 * secret (default: the dev secret in infra/keycloak/realm-vuu.json).
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { TRADING_FEATURES } from "../apps/features/trading/src/catalog";
import { stackConfig } from "./stack/config";
import {
  bootstrapRealm,
  DEV_PASSWORD,
  SEEDED_USERS,
} from "./stack/keycloak-realm";
import { modulesYaml } from "./stack/modules";

const root = resolve(import.meta.dir, "..");
const portalConfigDir = resolve(root, "apps/portal-config");
const runDir = resolve(root, ".run");
const cfg = stackConfig();
const args = new Set(process.argv.slice(2));

const log = (msg: string) => console.log(`[start-all] ${msg}`);
function fail(msg: string): never {
  console.error(`[start-all] ${msg}`);
  shutdown(1);
  throw new Error(msg);
}

// ---- child processes -------------------------------------------------------
type Child = { name: string; proc: ReturnType<typeof Bun.spawn> };
const children: Child[] = [];
let stopping = false;

const shutdown = async (code = 0) => {
  if (stopping) return;
  stopping = true;
  if (children.length)
    log(`stopping ${children.map((c) => c.name).join(", ")}`);
  for (const { proc } of [...children].reverse()) proc.kill("SIGTERM");
  const deadline = Date.now() + 15_000;
  for (const { name, proc } of children) {
    const left = Math.max(0, deadline - Date.now());
    const done = await Promise.race([
      proc.exited.then(() => true),
      Bun.sleep(left).then(() => false),
    ]);
    if (!done) {
      log(`${name} did not stop, killing`);
      proc.kill("SIGKILL");
    }
  }
  process.exit(code);
};
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

const spawn = (
  name: string,
  cmd: string[],
  env: Record<string, string> = {},
) => {
  const proc = Bun.spawn(cmd, {
    cwd: root,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const pipe = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    let buffered = "";
    for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
      buffered += decoder.decode(chunk, { stream: true });
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines)
        if (line.trim()) console.log(`[${name}] ${line}`);
    }
  };
  pipe(proc.stdout);
  pipe(proc.stderr);
  proc.exited.then((code) => {
    if (stopping) return;
    log(`${name} exited with code ${code}`);
    shutdown(code || 1);
  });
  children.push({ name, proc });
  return proc;
};

const sh = (cmd: string[], cwd = root) => {
  const result = Bun.spawnSync(cmd, {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) fail(`${cmd.join(" ")} failed`);
};

// ---- readiness -------------------------------------------------------------
const insecure = { tls: { rejectUnauthorized: false } } as RequestInit;
const httpOk = async (url: string) => {
  try {
    const res = await fetch(url, {
      ...insecure,
      signal: AbortSignal.timeout(2000),
    });
    return res.status < 500;
  } catch {
    return false;
  }
};
const portOpen = (port: number, host = cfg.host) =>
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
const waitFor = async (
  what: string,
  probe: () => Promise<boolean>,
  timeoutMs = 120_000,
) => {
  const started = Date.now();
  while (!(await probe())) {
    if (stopping) return;
    if (Date.now() - started > timeoutMs)
      fail(`${what} not ready after ${timeoutMs / 1000}s`);
    await Bun.sleep(500);
  }
  log(`ready: ${what} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
};

// ---- 1. prerequisites ------------------------------------------------------
mkdirSync(runDir, { recursive: true });
sh(["bun", "./scripts/make-certs.ts"]);

const hostBuilt = existsSync(resolve(root, "apps/portal-host/dist/index.html"));
const featuresBuilt = TRADING_FEATURES.every((f) =>
  existsSync(
    resolve(root, `apps/features/trading/dist/${f.key}/mf-manifest.json`),
  ),
);
if (args.has("--build") || !hostBuilt || !featuresBuilt) {
  log("building portal host and trading features");
  sh(["bun", "run", "build"]);
}

// ---- 2. server config ------------------------------------------------------
// The servers run on the committed confs; ports / origins come from env vars
// (the confs' ${?VUU_*} lines, set by scripts/stack/serve.ts from cfg).
// The runtime module list is seeded once; reseed when the defaults change.
const defaults = modulesYaml(cfg.featuresOrigin);
writeFileSync(resolve(portalConfigDir, "default-modules.stack.yaml"), defaults);
const seedHashFile = resolve(runDir, "modules.seed");
const seedHash = createHash("sha256").update(defaults).digest("hex");
const runtimeModules = resolve(portalConfigDir, "modules.stack.yaml");
const previous = existsSync(seedHashFile)
  ? readFileSync(seedHashFile, "utf8")
  : "";
if (args.has("--reseed") || previous !== seedHash) {
  rmSync(runtimeModules, { force: true });
  writeFileSync(seedHashFile, seedHash);
  log("portal modules reseeded from the defaults");
}

if (args.has("--prepare")) {
  log("prepared: certs, builds, apps/portal-config/default-modules.stack.yaml");
  process.exit(0);
}

// Never take over a port someone else is using: report it and how to move.
const ports: [string, number, string][] = [
  ["portal websocket", cfg.portalWsPort, "TRADER_PORTAL_WS_PORT"],
  ["portal https", cfg.portalHttpsPort, "TRADER_PORTAL_HTTPS_PORT"],
  ["trading websocket", cfg.tradingWsPort, "TRADER_TRADING_WS_PORT"],
  ["trading https", cfg.tradingHttpsPort, "TRADER_TRADING_HTTPS_PORT"],
  ["portal host", cfg.hostPort, "TRADER_HOST_PORT"],
  ["features", cfg.featuresPort, "TRADER_FEATURES_PORT"],
];
for (const [what, port, env] of args.has("--keycloak-only") ? [] : ports)
  if (await portOpen(port))
    fail(`port ${port} (${what}) is in use: stop that process or set ${env}`);

// ---- 3. Keycloak -----------------------------------------------------------
const realmUrl = `${cfg.keycloakUrl}/realms/master`;
const findKeycloakHome = () => {
  if (process.env.KEYCLOAK_HOME) return process.env.KEYCLOAK_HOME;
  const dir = resolve(homedir(), "keycloak");
  if (!existsSync(dir)) return undefined;
  const install = readdirSync(dir)
    .filter((name) => name.startsWith("keycloak-"))
    .sort()
    .pop();
  return install ? resolve(dir, install) : undefined;
};

if (await httpOk(realmUrl)) {
  log(`using running Keycloak at ${cfg.keycloakUrl}`);
} else if (process.env.TRADER_KEYCLOAK_URL) {
  fail(`TRADER_KEYCLOAK_URL=${cfg.keycloakUrl} is not reachable`);
} else {
  const home = findKeycloakHome();
  if (!home || !existsSync(resolve(home, "bin/kc.sh")))
    fail(
      "no Keycloak: install one (KEYCLOAK_HOME, or ~/keycloak/keycloak-<version>), " +
        "or start the container with `docker compose up -d keycloak`",
    );
  for (const [what, port] of [
    ["keycloak https", cfg.keycloakPort],
    ["keycloak http", cfg.keycloakHttpPort],
    ["keycloak management", cfg.keycloakManagementPort],
  ] as const)
    if (await portOpen(port))
      fail(
        `port ${port} (${what}) is in use: set TRADER_KEYCLOAK_* or TRADER_KEYCLOAK_URL`,
      );
  const certs = resolve(portalConfigDir, "certs");
  const db = resolve(runDir, "keycloak/keycloakdb");
  mkdirSync(resolve(runDir, "keycloak"), { recursive: true });
  log(`starting Keycloak from ${home} (state in .run/keycloak)`);
  spawn(
    "keycloak",
    [
      resolve(home, "bin/kc.sh"),
      "start-dev",
      `--https-port=${cfg.keycloakPort}`,
      `--http-port=${cfg.keycloakHttpPort}`,
      `--http-management-port=${cfg.keycloakManagementPort}`,
      `--https-certificate-file=${resolve(certs, "cert.pem")}`,
      `--https-certificate-key-file=${resolve(certs, "key.pem")}`,
      "--db=dev-file",
      `--db-url=jdbc:h2:file:${db};NON_KEYWORDS=VALUE`,
      "--hostname-strict=false",
    ],
    {
      KC_BOOTSTRAP_ADMIN_USERNAME:
        process.env.KEYCLOAK_ADMIN_USERNAME ?? "admin",
      KC_BOOTSTRAP_ADMIN_PASSWORD:
        process.env.KEYCLOAK_ADMIN_PASSWORD ?? "admin",
    },
  );
  await waitFor(`Keycloak ${cfg.keycloakUrl}`, () => httpOk(realmUrl), 180_000);
}
const realm = await bootstrapRealm(cfg).catch((error: Error) =>
  fail(`realm bootstrap: ${error.message}`),
);
log(`realm "${cfg.keycloakRealm}" ${realm}`);
if (args.has("--keycloak-only")) {
  log(`ready: keycloak only (${cfg.keycloakUrl})`);
  await new Promise(() => undefined);
}

// ---- 4. servers ------------------------------------------------------------
spawn("portal", ["bun", "./scripts/stack/serve.ts", "portal"]);
spawn("trading", ["bun", "./scripts/stack/serve.ts", "trading"]);
spawn("features", ["bun", "./scripts/stack/serve.ts", "features"]);
spawn("host", ["bun", "./scripts/stack/serve.ts", "host"]);

await Promise.all([
  waitFor(`portal https :${cfg.portalHttpsPort}`, () =>
    httpOk(`https://${cfg.host}:${cfg.portalHttpsPort}/`),
  ),
  waitFor(`portal websocket :${cfg.portalWsPort}`, () =>
    portOpen(cfg.portalWsPort),
  ),
  waitFor(`trading https :${cfg.tradingHttpsPort}`, () =>
    httpOk(`https://${cfg.host}:${cfg.tradingHttpsPort}/`),
  ),
  waitFor(`trading websocket :${cfg.tradingWsPort}`, () =>
    portOpen(cfg.tradingWsPort),
  ),
  waitFor(`features ${cfg.featuresOrigin}`, () =>
    httpOk(`${cfg.featuresOrigin}/${TRADING_FEATURES[0].key}/mf-manifest.json`),
  ),
  waitFor(`host ${cfg.hostOrigin}`, () => httpOk(`${cfg.hostOrigin}/health`)),
]);

const users = SEEDED_USERS.map(
  (u) =>
    `${u.username.padEnd(6)} ${[...u.roles, ...(u.portal ?? [])].join(", ")}`,
).join("\n    ");
console.log(`
  Trader stack is up. Open ${cfg.hostOrigin}

  Accept the self-signed certificate once for each https origin:
    ${cfg.keycloakUrl}   https://${cfg.host}:${cfg.portalHttpsPort}   https://${cfg.host}:${cfg.portalWsPort}
    https://${cfg.host}:${cfg.tradingHttpsPort}   https://${cfg.host}:${cfg.tradingWsPort}

  Users (password "${DEV_PASSWORD}"):
    ${users}

  Keycloak admin: ${cfg.keycloakUrl}/admin (admin / admin)
  Ctrl-C stops everything started here.
`);
