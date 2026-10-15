/**
 * Ladder frame budget: headless Chrome runs the showcase's PriceLadder stress
 * benchmark (synthetic book updated `rate` times a second, React <Profiler>
 * in the profiling build) and checks that ladder updates fit a frame:
 * p95 React render (commit actualDuration) and p95 update -> committed DOM
 * latency under --budget ms (default 16). Long (dropped) frames are always
 * reported; they only fail the check when --max-dropped-pct is given, as
 * page FPS is dominated by machine load rather than the ladder.
 *
 *   bun run perf:ladder [--rates=50,100,200] [--seconds=10] [--budget=16]
 *     [--throttle=1] [--max-dropped-pct=N] [--assert] [--reuse-build]
 *     [--headed]
 *
 * Opt-in (needs Chrome): it is not part of CI; the CI-safe check is the
 * PriceLadder render-count test in packages/trading-ui. See docs/performance.md.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildShowcase, launchChrome, serveStatic } from "./lib/browser";
import { mdTable, parseArgs, RESULTS_DIR, resultsPath } from "./lib/util";

const args = parseArgs();
const rates = (args.rates ?? "50,100,200").split(",").map(Number);
const seconds = Number(args.seconds ?? 10);
const budget = Number(args.budget ?? 16);
const throttle = Number(args.throttle ?? 1);
const maxDroppedPct =
  args["max-dropped-pct"] === undefined
    ? undefined
    : Number(args["max-dropped-pct"]);

interface StressSummary {
  rate: number;
  updatesPerSec: number;
  fps: number;
  renderAvgMs: number;
  renderP95Ms: number;
  renderMaxMs: number;
  commitP95Ms: number;
  commitMaxMs: number;
  frameP95Ms: number;
  longFrames: number;
}

async function main() {
  const out = resultsPath("ladder-budget");
  const distPath = resolve(RESULTS_DIR, ".showcase");
  await buildShowcase(distPath, {}, args["reuse-build"] === "true");
  const http = serveStatic(distPath);
  const browser = await launchChrome(args.headed === "true");
  const results: (StressSummary & { pass: boolean; failures: string[] })[] = [];
  try {
    for (const rate of rates) {
      const page = await browser.newPage({
        viewport: { width: 1200, height: 1000 },
      });
      if (throttle > 1) {
        const cdp = await page.context().newCDPSession(page);
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });
      }
      await page.goto(
        `http://localhost:${http.port}/?rate=${rate}&autorun=1&seconds=${seconds}#price-ladder-stress`,
      );
      const result = page.getByTestId("price-ladder-perf-result");
      await result.waitFor({ state: "attached", timeout: 30_000 });
      await page.waitForFunction(
        () =>
          document
            .querySelector("[data-testid=price-ladder-perf-result]")
            ?.textContent?.startsWith("{"),
        undefined,
        { timeout: (seconds + 20) * 1_000 },
      );
      const summary = JSON.parse(
        (await result.textContent()) ?? "{}",
      ) as StressSummary;
      // long frames are counted once per frame over budget: as a share of
      // the frames rendered
      const droppedPct =
        (100 * summary.longFrames) / Math.max(1, summary.fps * seconds);
      const failures = [
        summary.renderP95Ms > budget &&
          `render p95 ${summary.renderP95Ms}ms > ${budget}ms`,
        summary.commitP95Ms > budget &&
          `update->commit p95 ${summary.commitP95Ms}ms > ${budget}ms`,
        maxDroppedPct !== undefined &&
          droppedPct > maxDroppedPct &&
          `long frames ${droppedPct.toFixed(1)}% > ${maxDroppedPct}%`,
      ].filter((f): f is string => typeof f === "string");
      results.push({ ...summary, rate, pass: !failures.length, failures });
      console.log(
        `rate ${rate}/s: render p95 ${summary.renderP95Ms}ms, update->commit p95 ${summary.commitP95Ms}ms, update->frame p95 ${summary.frameP95Ms}ms, fps ${summary.fps}${failures.length ? `  FAIL: ${failures.join("; ")}` : ""}`,
      );
      await page.close();
    }
  } finally {
    await browser.close();
    http.stop(true);
  }
  const report = {
    config: {
      rates,
      seconds,
      budgetMs: budget,
      throttle,
      maxDroppedPct,
      date: new Date().toISOString(),
    },
    results,
  };
  writeFileSync(`${out}.json`, JSON.stringify(report, null, 2));
  const md = [
    `## Ladder frame budget (p95 < ${budget}ms, CPU throttle x${throttle})`,
    "",
    `${report.config.date}, ${seconds}s per rate`,
    "",
    mdTable(
      [
        "rate/s",
        "updates/s",
        "FPS",
        "render avg / p95 / max ms",
        "update→commit p95 ms",
        "update→frame p95 ms",
        "long frames",
        "result",
      ],
      results.map((r) => [
        r.rate,
        r.updatesPerSec,
        r.fps,
        `${r.renderAvgMs} / ${r.renderP95Ms} / ${r.renderMaxMs}`,
        r.commitP95Ms,
        r.frameP95Ms,
        r.longFrames,
        r.pass ? "pass" : `FAIL: ${r.failures.join("; ")}`,
      ]),
    ),
    "",
  ].join("\n");
  writeFileSync(`${out}.md`, md);
  console.log(`\n${md}\nwrote ${out}.json / .md`);
  if (args.assert === "true" && results.some((r) => !r.pass)) process.exit(1);
}

// exit explicitly: the browser connection can keep the event loop alive
main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
