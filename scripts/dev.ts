/**
 * bun run dev
 *
 * Starts, with prefixed output:
 *   server  vuu-portal + exchange-sim modules   wss://localhost:8091/websocket-portal
 *   hello   the hello module-federation remote  http://localhost:5010
 *   host    (optional) static portal host build http://localhost:5001   [VUU_PORTAL_HOST_DIR]
 *
 * Keycloak (https://localhost:8080, realm "vuu") must already be running, see README.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const hostDir = process.env.VUU_PORTAL_HOST_DIR
  ? resolve(root, process.env.VUU_PORTAL_HOST_DIR)
  : undefined;

const run = (name: string, cmd: string[], cwd = root) => {
  const proc = Bun.spawn(cmd, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const pipe = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
      for (const line of decoder.decode(chunk).split("\n")) {
        if (line.trim()) console.log(`[${name}] ${line}`);
      }
    }
  };
  pipe(proc.stdout);
  pipe(proc.stderr);
  proc.exited.then((code) => {
    console.log(`[${name}] exited with code ${code}`);
    if (code !== 0) shutdown(code ?? 1);
  });
  return proc;
};

const children: ReturnType<typeof run>[] = [];
const shutdown = (code = 0) => {
  for (const child of children) child.kill();
  process.exit(code);
};
process.on("SIGINT", () => shutdown());
process.on("SIGTERM", () => shutdown());

const sh = (cmd: string[], cwd = root) => {
  const result = Bun.spawnSync(cmd, {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) process.exit(result.exitCode ?? 1);
};

sh(["bun", "./scripts/make-certs.ts"]);
if (!existsSync(resolve(root, "node_modules/@heswell/vuu-server")))
  sh(["bun", "./scripts/link-vuu-websocket.ts"]);
const helloDir = resolve(root, "apps/features/hello");
if (!existsSync(resolve(helloDir, "dist/mf-manifest.json")))
  sh(["bun", "run", "build"], helloDir);

children.push(
  run("server", ["bun", "./apps/portal-config/src/start-portal.ts"]),
);
children.push(run("hello", ["bun", "./scripts/serve.ts"], helloDir));

if (hostDir) {
  children.push(
    run("host", ["bunx", "serve", "--single", "--listen", "5001", hostDir]),
  );
} else {
  console.log(
    "[dev] VUU_PORTAL_HOST_DIR not set: not starting a portal host on :5001 (see README)",
  );
}
