/**
 * Runs tsc and reports only diagnostics located in this repo. The linked
 * vuu-websocket sources are type-checked transitively and currently have their own
 * errors (see docs/upstream-issues.md), which must not fail our build.
 */
const proc = Bun.spawnSync(
  ["bunx", "tsc", "--noEmit", "-p", "tsconfig.json", "--pretty", "false"],
  {
    cwd: `${import.meta.dir}/..`,
    stdout: "pipe",
    stderr: "pipe",
  },
);
const lines = proc.stdout.toString().split("\n");
const ours: string[] = [];
let external = 0;
let keep = false;
for (const line of lines) {
  if (/^\S.*\(\d+,\d+\): error TS/.test(line) || /^error TS/.test(line)) {
    keep = !line.startsWith("../");
    if (!keep) external++;
  }
  if (keep && line.trim()) ours.push(line);
}
if (ours.length > 0) {
  console.error(ours.join("\n"));
  console.error(
    `\n${ours.filter((l) => /error TS/.test(l)).length} type error(s)`,
  );
  process.exit(1);
}
console.log(
  `typecheck ok (ignored ${external} diagnostics in linked vuu-websocket sources)`,
);
