/**
 * bun scripts/features/sync-build-config.ts [--check]
 *
 * Module federation only shares a dependency when the host and every remote
 * declare it identically. This writes the canonical `shared` block and the
 * `cssInline` include list into apps/portal-host/portal-build.json and every
 * apps/features/<name>/portal-build.json (only the entries each package can
 * resolve), and generates apps/portal-config/default-modules.yaml from
 * apps/features/trading/src/catalog.ts. With --check it reports drift and
 * exits 1 instead (CI).
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { modulesYaml } from "../stack/modules";

interface SharedConfig {
  singleton?: boolean;
  requiredVersion: string;
  strictVersion?: boolean;
}

const root = resolve(import.meta.dir, "../..");
const vuu = (name: string): [string, SharedConfig] => [
  name,
  {
    singleton: true,
    requiredVersion: "package:@vuu-ui/core",
    strictVersion: true,
  },
];

/**
 * One instance per page (docs/portal-integration.md, "MF sharing"):
 * react / react-dom / router (hooks, context), @vuu-ui/core (+ /portal) for
 * the host's DataProvider, persistence and module registry, data-remote and
 * notifications (connection + toasts), Salt (theme context) and trading-ui
 * (the instrument link bus, feature-root lease and ticket launcher).
 *
 * NOT @vuu-ui/vuu-layout: its shared chunk bundles vuu-data-react, which
 * imports @vuu-ui/vuu-layout again, and the MF runtime deadlocks loading it
 * (upstream #43). Each feature owns its layout, so a private copy is fine.
 */
export const SHARED: Record<string, SharedConfig> = Object.fromEntries([
  [
    "react",
    { singleton: true, requiredVersion: "^19.2.3", strictVersion: true },
  ],
  [
    "react-dom",
    { singleton: true, requiredVersion: "^19.2.3", strictVersion: true },
  ],
  [
    "react-router-dom",
    { singleton: true, requiredVersion: "^7.18.3", strictVersion: true },
  ],
  [
    "@vuu-ui/core",
    { singleton: true, requiredVersion: "package", strictVersion: true },
  ],
  vuu("@vuu-ui/core/portal"),
  vuu("@vuu-ui/vuu-data-remote"),
  vuu("@vuu-ui/vuu-notifications"),
  ["@salt-ds/core", { singleton: true, requiredVersion: "^1.67.0" }],
  ["@heswell/trading-ui", { singleton: true, requiredVersion: "^0.1.0" }],
]);

const packageDirs = () => {
  const features = resolve(root, "apps/features");
  return [
    resolve(root, "apps/portal-host"),
    ...readdirSync(features, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => resolve(features, d.name))
      .filter((dir) => existsSync(resolve(dir, "portal-build.json"))),
  ];
};

const resolvable = (name: string, dir: string) => {
  try {
    Bun.resolveSync(name, dir);
    return true;
  } catch {
    return false;
  }
};

const expected = (dir: string, current: Record<string, unknown>) => {
  const shared = Object.fromEntries(
    Object.entries(SHARED).filter(([name]) => resolvable(name, dir)),
  );
  const mf = current.moduleFederation as Record<string, unknown>;
  // cssInline turns `import "x.css"` in matching files into a string import
  // (for useComponentCssInjection). trading-ui is written that way, and so are
  // feature remotes; the host's plain stylesheet imports must stay as-is.
  const isHost = current.target === "host";
  const include = ["/packages/trading-ui/"];
  if (!isHost) include.push(`/${relative(root, dir)}/`);
  return {
    ...current,
    moduleFederation: { ...mf, shared },
    cssInline: { include },
  };
};

/** Format JSON exactly as `biome format` would, so `--check` matches CI. */
const biomeJson = (file: string, text: string) => {
  const out = Bun.spawnSync(
    ["bunx", "biome", "format", `--stdin-file-path=${file}`],
    { cwd: root, stdin: new TextEncoder().encode(text) },
  );
  if (out.exitCode !== 0) throw new Error(out.stderr.toString());
  return out.stdout.toString();
};

const check = process.argv.includes("--check");
const outputs: [string, (before: string) => string][] = [
  ...packageDirs().map((dir): [string, (before: string) => string] => [
    resolve(dir, "portal-build.json"),
    (before) =>
      biomeJson(
        resolve(dir, "portal-build.json"),
        `${JSON.stringify(expected(dir, JSON.parse(before)), null, 2)}\n`,
      ),
  ]),
  [
    resolve(root, "apps/portal-config/default-modules.yaml"),
    () => modulesYaml(),
  ],
];
let drift = 0;
for (const [file, generate] of outputs) {
  const before = existsSync(file) ? readFileSync(file, "utf8") : "";
  const after = generate(before);
  if (before === after) continue;
  drift++;
  if (check) console.error(`out of date: ${relative(root, file)}`);
  else {
    writeFileSync(file, after);
    console.log(`updated ${relative(root, file)}`);
  }
}
if (check && drift) {
  console.error("run: bun run features:sync");
  process.exit(1);
}
if (check) {
  // validate with the portal server's own loader (unique names / scopes /
  // paths, location format, child modules)
  const { loadDefaultModules } = await import("@heswell/vuu-portal");
  const file = resolve(root, "apps/portal-config/default-modules.yaml");
  const modules = loadDefaultModules(file, Date.now());
  console.log(`default-modules.yaml: ${modules.length} modules valid`);
}
