/**
 * @heswell/vuu-server, @heswell/service-utils and @heswell/vuu-portal are not published
 * to npm. This links them from a local vuu-websocket checkout into node_modules.
 *
 * Checkout location: $VUU_WEBSOCKET_DIR (env or .env), default ../vuu-websocket.
 * Runs on postinstall; failure to find the checkout is a warning, not an error,
 * so that `bun install` still works for people not touching the server side.
 */
import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const dir = resolve(root, process.env.VUU_WEBSOCKET_DIR ?? "../vuu-websocket");
const packages = ["vuu-server", "service-utils", "vuu-portal"];

if (!existsSync(resolve(dir, "packages/vuu-server/package.json"))) {
  console.warn(
    `[link-vuu-websocket] no vuu-websocket checkout at ${dir}. ` +
      "Clone https://github.com/heswell/vuu-websocket and set VUU_WEBSOCKET_DIR, then run `bun run link:vuu`.",
  );
  process.exit(process.env.CI ? 1 : 0);
}

if (!existsSync(resolve(dir, "node_modules"))) {
  console.warn(
    `[link-vuu-websocket] ${dir} has no node_modules, run \`npm install\` (or bun install) there first.`,
  );
}

for (const name of packages) {
  const target = resolve(dir, "packages", name);
  const link = resolve(root, "node_modules/@heswell", name);
  mkdirSync(dirname(link), { recursive: true });
  try {
    lstatSync(link);
    rmSync(link, { recursive: true, force: true });
  } catch {}
  symlinkSync(target, link, "dir");
  console.log(`[link-vuu-websocket] @heswell/${name} -> ${target}`);
}
