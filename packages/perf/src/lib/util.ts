/** Shared helpers for the perf scripts (scripts/perf). */
import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";

export const ROOT = resolve(import.meta.dir, "../../../..");
export const RESULTS_DIR = resolve(ROOT, "perf-results");

/** `--key=value` / `--flag` arguments. */
export const parseArgs = (argv = process.argv.slice(2)) =>
  Object.fromEntries(
    argv.map((arg) => {
      const [key, ...rest] = arg.replace(/^--/, "").split("=");
      return [key, rest.length ? rest.join("=") : "true"];
    }),
  ) as Record<string, string | undefined>;

export const percentile = (sorted: readonly number[], p: number) => {
  if (sorted.length === 0) return 0;
  const i = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1,
  );
  return sorted[Math.max(0, i)];
};

export interface Distribution {
  count: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export const distribution = (values: number[]): Distribution => {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((total, v) => total + v, 0);
  return {
    count: sorted.length,
    mean: sorted.length ? sum / sorted.length : 0,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted.at(-1) ?? 0,
  };
};

export const round = (n: number, dp = 1) => {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};

export const fmt = (n: number, dp = 0) =>
  n.toLocaleString("en-GB", {
    maximumFractionDigits: dp,
    minimumFractionDigits: dp,
  });

/** A free TCP port on localhost. */
export const freePort = () =>
  new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address
          ? resolvePort(address.port)
          : reject(Error("no port")),
      );
    });
  });

/** Is something listening on the port (localhost)? */
export const portInUse = (port: number) =>
  new Promise<boolean>((resolveInUse) => {
    const server = createServer();
    server.once("error", () => resolveInUse(true));
    server.listen(port, "127.0.0.1", () =>
      server.close(() => resolveInUse(false)),
    );
  });

export const resultsPath = (name: string) => {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return resolve(RESULTS_DIR, `${name}-${stamp}`);
};

/** Markdown table from rows of cells. */
export const mdTable = (header: string[], rows: (string | number)[][]) =>
  [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");

export const sleep = (ms: number) =>
  new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms));
