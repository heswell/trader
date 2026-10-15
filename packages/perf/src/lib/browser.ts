/** Headless Chrome + showcase build helpers for the UI perf scripts. */
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join, resolve } from "node:path";
import { type Browser, chromium } from "playwright";
import { ROOT } from "./util";

const globDirs = (dir: string, prefix: string) =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name.startsWith(prefix))
        .map((name) => join(dir, name))
        .sort()
        .reverse()
    : [];

/** CHROME_PATH, a system Chrome, or a Chrome cached by puppeteer / playwright. */
export const findChrome = () => {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    ...globDirs(join(homedir(), ".cache/puppeteer/chrome"), "").flatMap(
      (dir) => [
        join(
          dir,
          "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        ),
        join(
          dir,
          "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        ),
        join(dir, "chrome-linux64/chrome"),
      ],
    ),
  ];
  const found = candidates.find((path) => path && existsSync(path));
  if (!found) {
    throw Error(
      "no Chrome found: set CHROME_PATH (or install Google Chrome / `bunx puppeteer browsers install chrome`)",
    );
  }
  return found;
};

export const launchChrome = (headed = false): Promise<Browser> =>
  chromium.launch({
    executablePath: findChrome(),
    headless: !headed,
    args: [
      // keep timers / rAF at full rate in a background or headless window
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
    ],
  });

export const SHOWCASE_DIR = resolve(ROOT, "apps/showcase");

/**
 * Production showcase build with React's profiling build (so <Profiler>
 * works), into its own dist directory. Skipped when `reuse` and it exists.
 */
export async function buildShowcase(
  distPath: string,
  env: Record<string, string> = {},
  reuse = false,
) {
  if (reuse && existsSync(join(distPath, "index.html"))) return distPath;
  const started = performance.now();
  const build = Bun.spawn(["bun", "run", "build"], {
    cwd: SHOWCASE_DIR,
    env: {
      ...process.env,
      ...env,
      SHOWCASE_PROFILING: "1",
      SHOWCASE_DIST_PATH: distPath,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([
    build.exited,
    new Response(build.stdout).text(),
    new Response(build.stderr).text(),
  ]);
  if (code !== 0) throw Error(`showcase build failed:\n${out}\n${err}`);
  console.log(
    `built showcase (profiling) in ${Math.round((performance.now() - started) / 1_000)}s`,
  );
  return distPath;
}

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

/** Static server for a build directory on a free port. */
export const serveStatic = (dir: string, port = 0) =>
  Bun.serve({
    port,
    hostname: "localhost",
    fetch(request) {
      const { pathname } = new URL(request.url);
      let path = join(dir, decodeURIComponent(pathname));
      if (
        !path.startsWith(dir) ||
        !existsSync(path) ||
        statSync(path).isDirectory()
      ) {
        path = join(dir, "index.html");
      }
      return new Response(Bun.file(path), {
        headers: {
          "Content-Type": MIME[extname(path)] ?? "application/octet-stream",
        },
      });
    },
  });
