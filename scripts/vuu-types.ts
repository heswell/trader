/**
 * Emits .d.ts files for the linked vuu-websocket packages into .vuu-types/ so that
 * trader is type-checked against their API without type-checking their sources
 * (which do not typecheck, see docs/upstream-issues.md). Runtime still uses the
 * symlinked src. Requires TypeScript >= 5.5 (--noCheck).
 */
import { existsSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const linked = (name: string) => resolve(root, "node_modules/@heswell", name);

if (!existsSync(linked("vuu-server"))) {
  console.error(
    "[vuu-types] packages not linked, run `bun run link:vuu` first",
  );
  process.exit(1);
}

const out = resolve(root, ".vuu-types");
const tmpConfig = resolve(root, ".vuu-types.tsconfig.json");
rmSync(out, { recursive: true, force: true });
const base = resolve(realpathSync(linked("vuu-server")), "..");
writeFileSync(
  tmpConfig,
  JSON.stringify({
    extends: "./tsconfig.json",
    compilerOptions: {
      noEmit: false,
      declaration: true,
      emitDeclarationOnly: true,
      noCheck: true,
      outDir: out,
      rootDir: base,
      paths: {},
    },
    include: [],
    files: [
      "vuu-server/src/index.ts",
      "service-utils/src/index.ts",
      "vuu-portal/src/index.ts",
      "vuu-portal/src/ModuleRegistry.ts",
      "vuu-portal/src/modules/ModuleDiscovery/ModuleDiscoveryModule.ts",
    ].map((f) => resolve(base, f)),
  }),
);
// Declaration emit reports some errors but still writes the files.
Bun.spawnSync(["bunx", "tsc", "-p", tmpConfig, "--pretty", "false"], {
  cwd: root,
  stdout: "ignore",
  stderr: "ignore",
});
rmSync(tmpConfig, { force: true });
if (!existsSync(resolve(out, "vuu-server/src/index.d.ts"))) {
  console.error("[vuu-types] declaration emit failed");
  process.exit(1);
}
console.log(`[vuu-types] wrote ${out}`);
