import { resolve } from "node:path";

const certs = Bun.spawnSync(
  ["bun", resolve(import.meta.dir, "../../../scripts/make-certs.ts")],
  {
    stdout: "inherit",
    stderr: "inherit",
  },
);
if (certs.exitCode !== 0) process.exit(certs.exitCode ?? 1);

process.env.VUU_CONFIG_FILE ??= resolve(import.meta.dir, "../application.conf");
const { default: start } = await import("../src/Main");
await start();
