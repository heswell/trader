/**
 * bun scripts/features/build.ts [key ...]
 *
 * Builds one module-federation remote per trading feature (the portal needs
 * a unique mfScope per module) from apps/features/trading: for each entry in
 * src/catalog.ts it derives a portal-build config from the package's
 * portal-build.json (MF name = mfScope, a single expose, output dist/<key>)
 * and runs portal-build. portal-build writes each remote's manifest, a
 * config.json next to its mf-manifest.json naming the trading Vuu server it
 * connects to (scripts/stack/config.ts featureConfigJson, TRADER_TRADING_*
 * env vars), and a default serve.json (CORS + SPA fallback) for static hosts.
 * Serve dist/ with scripts/stack/serve.ts features.
 */
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { TRADING_FEATURES } from "../../apps/features/trading/src/catalog";
import { featureConfigJson, stackConfig } from "../stack/config";

const pkg = resolve(import.meta.dir, "../../apps/features/trading");
const base = await Bun.file(resolve(pkg, "portal-build.json")).json();
const packageName: string = (
  await Bun.file(resolve(pkg, "package.json")).json()
).name;

/**
 * Remote builds load chunks through a JSONP global named after the package
 * (`rspackChunk_<package name>`), and portal-build has no uniqueName option
 * (upstream #44). All our remotes come from one package, so two of them on a
 * page would push chunks into each other's array: give each its own global.
 */
const chunkGlobal = `rspackChunk_${packageName.replace(/^@/, "").replace(/[^a-zA-Z0-9]/g, "_")}`;
const renameChunkGlobal = (dir: string, mfScope: string) => {
  let found = 0;
  for (const entry of readdirSync(dir, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
    const file = resolve(entry.parentPath, entry.name);
    const source = readFileSync(file, "utf8");
    if (!source.includes(chunkGlobal)) continue;
    found++;
    writeFileSync(
      file,
      source.replaceAll(chunkGlobal, `rspackChunk_${mfScope}`),
    );
  }
  if (found === 0)
    throw new Error(`${dir}: chunk global ${chunkGlobal} not found`);
};
const only = process.argv.slice(2);
const features = TRADING_FEATURES.filter(
  (f) => only.length === 0 || only.includes(f.key),
);

if (only.length === 0)
  rmSync(resolve(pkg, "dist"), { force: true, recursive: true });

for (const feature of features) {
  const config = {
    ...base,
    paths: { ...base.paths, output: `./dist/${feature.key}` },
    html: { title: `${feature.title} (standalone)` },
    manifest: { ...base.manifest, remote: featureConfigJson(stackConfig()) },
    moduleFederation: {
      ...base.moduleFederation,
      name: feature.mfScope,
      exposes: { [feature.expose]: feature.source },
    },
  };
  // portal-build resolves paths against the config's directory, so the
  // derived config sits next to the base one (gitignored).
  const file = resolve(pkg, `.portal-build.${feature.key}.json`);
  writeFileSync(file, JSON.stringify(config, null, 2));
  const started = performance.now();
  const result = Bun.spawnSync(["bunx", "portal-build", "--config", file], {
    cwd: pkg,
    stdout: "pipe",
    stderr: "pipe",
  });
  rmSync(file, { force: true });
  if (result.exitCode !== 0) {
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    console.error(`[features] ${feature.key} failed`);
    process.exit(result.exitCode ?? 1);
  }
  renameChunkGlobal(resolve(pkg, `dist/${feature.key}`), feature.mfScope);
  console.log(
    `[features] ${feature.key.padEnd(18)} ${feature.mfScope.padEnd(24)} ${Math.round(performance.now() - started)}ms`,
  );
}
