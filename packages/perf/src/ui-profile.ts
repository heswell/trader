/**
 * UI tick-rate profiling: headless Chrome loads a showcase scenario (default
 * the trader workspace: instrument grid, blotters, depth, ladder, tape) under
 * a raised tick rate and records frame timings.
 *
 *   bun run perf:ui [--data=remote|local] [--scenario=trader-workspace]
 *     [--tick=4] [--duration=15] [--warmup=5] [--throttle=1] [--reuse-build]
 *     [--headed]
 *
 * --data=remote (default) runs the exchange-sim + OMS in a local perf server
 * (src/perf-server.ts), so the page's main thread only pays for the UI;
 * --data=local uses the showcase's in-browser test data (engine-local + the
 * simulator in the page). --throttle=N applies CDP CPU throttling.
 * Writes perf-results/ui-profile-<stamp>.{json,md}. See docs/performance.md.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CDPSession, Page } from "playwright";
import { buildShowcase, launchChrome, serveStatic } from "./lib/browser";
import { type PerfServer, startPerfServer } from "./lib/perfServer";
import {
  distribution,
  fmt,
  freePort,
  mdTable,
  parseArgs,
  RESULTS_DIR,
  resultsPath,
  round,
  sleep,
} from "./lib/util";

const args = parseArgs();
const num = (key: string, fallback: number) =>
  args[key] === undefined ? fallback : Number(args[key]);
const data = args.data ?? "remote";
const scenario = args.scenario ?? "trader-workspace";
const tick = num("tick", 4);
const duration = num("duration", 15);
const warmup = num("warmup", 5);
const throttle = num("throttle", 1);
const mmRate = 10 * tick;
const takerRate = 8 * tick;
const cpuProfile = args["cpu-profile"] === "true";

interface CpuProfile {
  nodes: {
    id: number;
    callFrame: {
      functionName: string;
      url: string;
      lineNumber: number;
      columnNumber: number;
    };
  }[];
  samples: number[];
  timeDeltas: number[];
}

/** Self time per function (top N) from a CDP CPU profile. */
const topFunctions = (profile: CpuProfile, secs: number, n = 25) => {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const self = new Map<string, number>();
  profile.samples.forEach((id, i) => {
    const frame = byId.get(id)?.callFrame;
    if (!frame) return;
    const file = frame.url.split("/").pop() ?? "";
    const key = `${frame.functionName || "(anonymous)"} ${file}:${frame.lineNumber + 1}:${frame.columnNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + (profile.timeDeltas[i] ?? 0) / 1_000);
  });
  return [...self.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([fn, ms]) => ({ fn, msPerSec: round(ms / secs) }));
};

/** In-page recorder: rAF intervals, long tasks, LoAF, DOM mutations. */
const RECORDER = () => {
  const w = window as unknown as { __perf: Record<string, unknown> };
  const frames: number[] = [];
  const longTasks: number[] = [];
  const loaf: { duration: number; blocking: number; script: number }[] = [];
  let mutations = 0;
  let last = performance.now();
  let running = true;
  const loop = (now: number) => {
    frames.push(now - last);
    last = now;
    if (running) requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  const observers: PerformanceObserver[] = [];
  const observe = (type: string, fn: (e: PerformanceEntry) => void) => {
    try {
      const o = new PerformanceObserver((list) =>
        list.getEntries().forEach(fn),
      );
      o.observe({ type });
      observers.push(o);
    } catch {
      // entry type not supported
    }
  };
  observe("longtask", (e) => longTasks.push(e.duration));
  observe("long-animation-frame", (e) => {
    const f = e as PerformanceEntry & {
      blockingDuration: number;
      scripts: { duration: number }[];
    };
    loaf.push({
      duration: f.duration,
      blocking: f.blockingDuration,
      script: f.scripts.reduce((t, s) => t + s.duration, 0),
    });
  });
  const mo = new MutationObserver((records) => {
    mutations += records.length;
  });
  mo.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
  });
  const started = performance.now();
  w.__perf = {
    stop: () => {
      running = false;
      mo.disconnect();
      for (const o of observers) o.disconnect();
      return {
        elapsedMs: performance.now() - started,
        frames: frames.slice(1),
        longTasks,
        loaf,
        mutations,
      };
    },
  };
};

type Recorded = {
  elapsedMs: number;
  frames: number[];
  longTasks: number[];
  loaf: { duration: number; blocking: number; script: number }[];
  mutations: number;
};

const cdpMetrics = async (cdp: CDPSession) => {
  const { metrics } = (await cdp.send("Performance.getMetrics")) as {
    metrics: { name: string; value: number }[];
  };
  return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
};

/**
 * Select an instrument so depth / ladder / tape are live: the first grid row
 * (red link group) and, in the workspace, a green ric in the picker.
 */
async function primeScenario(page: Page) {
  if (
    ![
      "trader-workspace",
      "price-ladder-live",
      "market-depth-selected",
    ].includes(scenario)
  ) {
    return;
  }
  const row = page.locator(".vuuTableRow[aria-rowindex]").first();
  await row.waitFor({ timeout: 30_000 });
  await row.click();
  const picker = page.getByLabel("Green instrument").locator("input");
  if (await picker.count()) {
    await picker.fill("A");
    await page.getByRole("option").first().click({ timeout: 10_000 });
  }
}

async function main() {
  const out = resultsPath(`ui-profile-${scenario}-${data}`);
  let server: PerfServer | undefined;
  const distPath = resolve(RESULTS_DIR, ".showcase");
  let query: string;
  const appPort = await freePort();
  await buildShowcase(distPath, {}, args["reuse-build"] === "true");
  if (data === "remote") {
    server = await startPerfServer({
      env: {
        EXCHANGE_SIM_MM_RATE: String(mmRate),
        EXCHANGE_SIM_TAKER_RATE: String(takerRate),
      },
      corsOrigins: [`http://localhost:${appPort}`],
    });
    query = `?data=remote&ws=${encodeURIComponent(server.wsUrl)}&auth=${encodeURIComponent(server.authUrl)}`;
  } else {
    query = `?mmRate=${mmRate}&takerRate=${takerRate}`;
  }
  const http = serveStatic(distPath, appPort);
  const browser = await launchChrome(args.headed === "true");
  const cleanup = async () => {
    await browser.close().catch(() => undefined);
    http.stop(true);
    await server?.stop();
  };
  const watchdog = setTimeout(
    async () => {
      console.error("ui-profile timed out");
      await cleanup();
      process.exit(1);
    },
    (warmup + duration + 120) * 1_000,
  );
  try {
    const page = await browser.newPage({
      viewport: { width: 1600, height: 1000 },
    });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    if (throttle > 1) {
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });
    }
    const url = `http://localhost:${appPort}/${query}#${scenario}`;
    console.log(
      `ui-profile ${scenario} (${data} data, tick x${tick}, throttle x${throttle}): ${url}`,
    );
    // remote mode can crash on load (trader upstream issue 87): retry
    for (let attempt = 1; ; attempt++) {
      try {
        await page.goto(url);
        await primeScenario(page);
        break;
      } catch (error) {
        await page.screenshot({ path: `${out}-failed.png` });
        const message = `${scenario} did not load (attempt ${attempt}, see ${out}-failed.png): ${(error as Error).message.split("\n")[0]}\n${errors.join("\n")}`;
        if (attempt === 3) throw Error(message);
        console.warn(message);
        errors.length = 0;
      }
    }
    console.log(`loaded; warming up ${warmup}s, then measuring ${duration}s`);
    await sleep(warmup * 1_000);
    const before = await cdpMetrics(cdp);
    if (cpuProfile) {
      await cdp.send("Profiler.enable");
      await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
      await cdp.send("Profiler.start");
    }
    await page.evaluate(RECORDER);
    await sleep(duration * 1_000);
    const recorded = (await page.evaluate(() =>
      (window as unknown as { __perf: { stop: () => unknown } }).__perf.stop(),
    )) as Recorded;
    const after = await cdpMetrics(cdp);
    let hot: ReturnType<typeof topFunctions> | undefined;
    if (cpuProfile) {
      const { profile } = (await cdp.send("Profiler.stop")) as {
        profile: CpuProfile;
      };
      writeFileSync(`${out}.cpuprofile`, JSON.stringify(profile));
      hot = topFunctions(profile, recorded.elapsedMs / 1_000);
    }
    await page.screenshot({ path: `${out}.png` });
    const report = { ...summarise(recorded, before, after, errors), hot };
    writeFileSync(`${out}.json`, JSON.stringify(report, null, 2));
    const md = markdown(report);
    writeFileSync(`${out}.md`, md);
    console.log(`\n${md}\nwrote ${out}.json / .md / .png`);
  } finally {
    clearTimeout(watchdog);
    await cleanup();
  }
}

const FRAME_MS = 1000 / 60;

function summarise(
  r: Recorded,
  before: Record<string, number>,
  after: Record<string, number>,
  errors: string[],
) {
  const secs = r.elapsedMs / 1_000;
  const delta = (name: string) => (after[name] ?? 0) - (before[name] ?? 0);
  // a frame interval of n vsyncs means n-1 frames were skipped
  const dropped = r.frames.reduce(
    (t, d) => t + Math.max(0, Math.round(d / FRAME_MS) - 1),
    0,
  );
  const frames = distribution(r.frames);
  const longTasks = distribution(r.longTasks);
  return {
    config: {
      scenario,
      data,
      tick,
      sim: { mmRate, takerRate },
      throttle,
      durationSecs: duration,
      warmupSecs: warmup,
      date: new Date().toISOString(),
    },
    fps: round(r.frames.length / secs),
    frameMs: {
      p50: round(frames.p50),
      p95: round(frames.p95),
      p99: round(frames.p99),
      max: round(frames.max),
    },
    droppedFrames: dropped,
    droppedPct: round((100 * dropped) / (dropped + r.frames.length)),
    longTasks: {
      count: longTasks.count,
      perSec: round(longTasks.count / secs, 2),
      totalMs: round(longTasks.mean * longTasks.count),
      p95Ms: round(longTasks.p95),
      maxMs: round(longTasks.max),
    },
    longAnimationFrames: {
      count: r.loaf.length,
      blockingMs: round(r.loaf.reduce((t, f) => t + f.blocking, 0)),
      scriptMs: round(r.loaf.reduce((t, f) => t + f.script, 0)),
    },
    /** Main-thread time per wall second (CDP Performance metrics). */
    mainThreadMsPerSec: {
      scripting: round((1_000 * delta("ScriptDuration")) / secs),
      layout: round((1_000 * delta("LayoutDuration")) / secs),
      style: round((1_000 * delta("RecalcStyleDuration")) / secs),
      task: round((1_000 * delta("TaskDuration")) / secs),
    },
    layoutsPerSec: round(delta("LayoutCount") / secs),
    styleRecalcsPerSec: round(delta("RecalcStyleCount") / secs),
    domMutationsPerSec: round(r.mutations / secs),
    jsHeapMb: round((after.JSHeapUsedSize ?? 0) / 2 ** 20),
    pageErrors: errors,
  };
}

type Report = ReturnType<typeof summarise> & {
  hot?: { fn: string; msPerSec: number }[];
};

function markdown(r: Report) {
  const c = r.config;
  return [
    `## UI profile: ${c.scenario} (${c.data} data, tick x${c.tick}, CPU throttle x${c.throttle})`,
    "",
    `${c.date}, ${c.durationSecs}s window, sim mmRate ${c.sim.mmRate} takerRate ${c.sim.takerRate}`,
    "",
    mdTable(
      ["metric", "value"],
      [
        ["FPS", r.fps],
        [
          "frame interval p50 / p95 / p99 / max ms",
          `${r.frameMs.p50} / ${r.frameMs.p95} / ${r.frameMs.p99} / ${r.frameMs.max}`,
        ],
        ["dropped frames", `${r.droppedFrames} (${r.droppedPct}%)`],
        [
          "long tasks",
          `${r.longTasks.count} (${r.longTasks.perSec}/s, p95 ${r.longTasks.p95Ms} ms, max ${r.longTasks.maxMs} ms)`,
        ],
        [
          "long animation frames",
          `${r.longAnimationFrames.count} (blocking ${r.longAnimationFrames.blockingMs} ms)`,
        ],
        ["scripting ms/s", r.mainThreadMsPerSec.scripting],
        ["layout ms/s", r.mainThreadMsPerSec.layout],
        ["style recalc ms/s", r.mainThreadMsPerSec.style],
        ["main-thread busy ms/s", r.mainThreadMsPerSec.task],
        [
          "layouts/s, style recalcs/s",
          `${r.layoutsPerSec}, ${r.styleRecalcsPerSec}`,
        ],
        ["DOM mutations/s", fmt(r.domMutationsPerSec)],
        ["JS heap MB", r.jsHeapMb],
        ["page errors", r.pageErrors.length],
      ],
    ),
    "",
    ...(r.hot
      ? [
          "Top self time (CPU profile, ms per second; minified names in a production build):",
          "",
          mdTable(
            ["function", "ms/s"],
            r.hot.map((h) => [`\`${h.fn}\``, h.msPerSec]),
          ),
          "",
        ]
      : []),
  ].join("\n");
}

// exit explicitly: the browser connection can keep the event loop alive
main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
