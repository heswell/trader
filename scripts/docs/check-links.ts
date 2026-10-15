/**
 * Checks the relative links in the repo's markdown: the target file exists
 * and, for `#anchor` links into markdown, that the heading exists (GitHub
 * slugs, with -1, -2 suffixes for repeats). External links are not checked
 * (that would be flaky in CI).
 *
 *   bun scripts/docs/check-links.ts
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { Glob } from "bun";

const ROOT = resolve(import.meta.dirname, "../..");
const PATTERNS = [
  "README.md",
  "docs/**/*.md",
  "packages/*/README.md",
  "apps/**/README.md",
  "scripts/**/*.md",
];

const files = new Set<string>();
for (const pattern of PATTERNS)
  for (const file of new Glob(pattern).scanSync({ cwd: ROOT }))
    if (!file.includes("node_modules/") && !file.includes("/dist/"))
      files.add(file);

/** Markdown with fenced code blocks and inline code removed. */
const prose = (markdown: string) =>
  markdown
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, "")
    .replace(/`[^`\n]*`/g, "");

/** GitHub's heading slug. */
export const slug = (heading: string) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/<[^>]*>/g, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");

const anchorCache = new Map<string, Set<string>>();
const anchorsOf = (file: string) => {
  let anchors = anchorCache.get(file);
  if (!anchors) {
    anchors = new Set();
    const seen = new Map<string, number>();
    const text = readFileSync(file, "utf8").replace(
      /^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm,
      "",
    );
    for (const [, heading] of text.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
      const base = slug(heading.replace(/`/g, ""));
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      anchors.add(n ? `${base}-${n}` : base);
    }
    for (const [, id] of text.matchAll(/<a\s+(?:name|id)="([^"]+)"/g))
      anchors.add(id);
    anchorCache.set(file, anchors);
  }
  return anchors;
};

const problems: string[] = [];
let checked = 0;
for (const file of [...files].sort()) {
  const abs = join(ROOT, file);
  const text = prose(readFileSync(abs, "utf8"));
  const targets = [
    ...[...text.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)].map(
      (m) => m[1],
    ),
    ...[...text.matchAll(/^\s*\[[^\]]+\]:\s*(\S+)/gm)].map((m) => m[1]),
    ...[...text.matchAll(/<(?:a|img)\s[^>]*(?:href|src)="([^"]+)"/g)].map(
      (m) => m[1],
    ),
  ];
  for (const target of targets) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // http:, mailto:, ...
    checked += 1;
    const [path, anchor] = target.split("#", 2);
    const dest = path ? resolve(dirname(abs), decodeURI(path)) : abs;
    const where = `${file}: ${target}`;
    if (!dest.startsWith(ROOT)) {
      problems.push(`${where} points outside the repo`);
      continue;
    }
    if (!existsSync(dest)) {
      problems.push(`${where}: ${relative(ROOT, dest)} does not exist`);
      continue;
    }
    if (anchor && dest.endsWith(".md") && statSync(dest).isFile()) {
      if (!anchorsOf(dest).has(decodeURIComponent(anchor).toLowerCase()))
        problems.push(`${where}: no heading #${anchor}`);
    }
  }
}

if (problems.length) {
  console.error(problems.map((p) => `✗ ${p}`).join("\n"));
  console.error(`${problems.length} broken link(s) in ${files.size} files`);
  process.exit(1);
}
console.log(`links ok: ${checked} relative links in ${files.size} files`);
