/**
 * bun run e2e:resilience [--no-build] [--restarts=N] [--headed]
 *
 * Opt-in end-to-end resilience check (not part of CI: it needs Keycloak and
 * takes a few minutes). Starts its own stack, opens the Trader workspace in
 * headless Chromium as alice, then kills and restarts the trading Vuu server
 * N times (default 3; the first kill is SIGKILL, i.e. a crash) and checks:
 *
 *  - the header connection indicator goes connected -> reconnecting/
 *    disconnected -> connected,
 *  - ticking views are marked stale while the server is down,
 *  - the order ticket blocks submission while disconnected and re-enables,
 *  - the instrument grid repopulates and ticks again,
 *  - no "maximum sessions" refusal is seen after the restarts,
 * then restarts the portal server (--portal-restarts, default 1) and checks
 * the indicator recovers and the trading views keep ticking. Last
 * (--no-session-limit skips it) the trading server is restarted with
 * maxSessionsPerUser=1: a second tab is refused and keeps retrying (shown as
 * reconnecting, no error page), and connects once the first tab is closed.
 *
 * Ports: the start:all defaults when free, otherwise every server port shifted
 * by E2E_PORT_OFFSET (default +30) so it can run beside another stack. A
 * Keycloak already serving at the chosen URL is reused (never stopped);
 * everything this script spawns is stopped when it exits. Browsers:
 * `bunx playwright install chromium` once. Screenshots go to .run/.
 */
import { resolve } from "node:path";
import { chromium, type Page } from "playwright";
import {
  check,
  flag,
  CONNECTION_STATUS_SELECTOR,
  indicatorState,
  log,
  login,
  moduleError,
  option,
  output,
  portOpen,
  root,
  run,
  startStack,
  stop,
  waitUntil,
  mustWait,
} from "./harness";

const restarts = option("restarts", 3);
const portalRestarts = option("portal-restarts", 1);
const sessionLimit = !flag("no-session-limit");

// ---- checks ----------------------------------------------------------------
const ticketState = (page: Page) =>
  page.evaluate(() => {
    const form = document.querySelector<HTMLElement>(".tradingOrderTicket");
    const submit = form?.querySelector<HTMLButtonElement>(
      ".tradingOrderTicket-submit",
    );
    return form
      ? {
          connectionState: form.dataset.connectionState,
          blocked: !!form.querySelector(".tradingOrderTicket-blocked"),
          submitDisabled: !!submit?.disabled,
        }
      : undefined;
  });

const gridRows = (page: Page) =>
  page.evaluate(
    () =>
      document.querySelectorAll(
        ".tradingInstrumentGrid .vuuTableRow:not(.vuuRowProxy)",
      ).length,
  );

const staleCount = (page: Page) =>
  page.evaluate(() => document.querySelectorAll("[data-stale]").length);

/** The instrument grid's text: changes while prices tick. */
const gridText = (page: Page) =>
  page.evaluate(
    () => document.querySelector(".tradingInstrumentGrid")?.textContent ?? "",
  );

// ---- run -------------------------------------------------------------------
const main = async () => {
  const stack = await startStack();
  const { cfg, startPortal, startTrading } = stack;
  let { portal, trading } = stack;

  const browser = await chromium.launch({
    headless: !flag("headed"),
    args: ["--ignore-certificate-errors"],
  });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1600, height: 1000 },
  });
  const page = await context.newPage();
  const refusals: string[] = [];
  page.on("websocket", (ws) => {
    ws.on("framereceived", ({ payload }) => {
      const text = typeof payload === "string" ? payload : payload.toString();
      if (/maximum sessions/i.test(text)) refusals.push(text.slice(0, 200));
    });
  });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  const shot = (name: string) =>
    page.screenshot({ path: resolve(root, `.run/e2e-resilience-${name}.png`) });

  try {
    await page.goto(`${cfg.hostOrigin}/workspaces/trader`);
    await login(page);

    await mustWait(
      "indicator connected",
      async () => (await indicatorState(page)) === "connected",
      60_000,
    );
    await mustWait(
      "instrument grid rows",
      async () => {
        const error = await moduleError(page);
        if (error) throw Error(`workspace failed to load: ${error}`);
        return (await gridRows(page)) > 0;
      },
      60_000,
    );
    // select an instrument so the ticket can submit
    await page
      .locator(".tradingInstrumentGrid .vuuTableRow:not(.vuuRowProxy)")
      .first()
      .click();
    await waitUntil(
      async () => (await ticketState(page))?.submitDisabled === false,
      30_000,
    );
    const initialTicket = await ticketState(page);
    check(
      initialTicket?.connectionState === "connected" && !initialTicket.blocked,
      `ticket connected before restarts ${JSON.stringify(initialTicket)}`,
    );
    const submitWasEnabled = initialTicket?.submitDisabled === false;
    await shot("connected");

    for (let i = 1; i <= restarts; i++) {
      const signal = i === 1 ? "SIGKILL" : "SIGTERM";
      log(`--- restart ${i}/${restarts}: ${signal} the trading server`);
      await stop(trading, signal);

      const seen = new Set<string>();
      const track = async () => {
        const state = await indicatorState(page);
        if (state) seen.add(state);
        return state;
      };
      await waitUntil(async () => {
        const state = await track();
        return state !== null && state !== "connected";
      }, 30_000);
      const downState = await indicatorState(page);
      check(
        downState === "reconnecting" || downState === "disconnected",
        `indicator shows the outage (${downState})`,
      );
      await Bun.sleep(1_500);
      const ticket = await ticketState(page);
      check(
        !!ticket?.blocked && ticket.submitDisabled,
        `ticket blocked while down ${JSON.stringify(ticket)}`,
      );
      check((await staleCount(page)) > 0, "ticking views marked stale");
      if (i === 1) await shot("down");

      // stay down long enough for a few failed attempts
      await Bun.sleep(4_000 + i * 1_000);
      trading = startTrading();
      await mustWait("trading port", () => portOpen(cfg.tradingWsPort));

      const recoveredIn = await waitUntil(
        async () => (await track()) === "connected",
        90_000,
      );
      check(
        recoveredIn >= 0,
        `reconnected ${(recoveredIn / 1000).toFixed(1)}s after the server came back (states: ${[...seen].join(" -> ")})`,
      );
      check(
        (await waitUntil(async () => (await gridRows(page)) > 0, 30_000)) >= 0,
        "instrument grid repopulated",
      );
      const before = await gridText(page);
      check(
        (await waitUntil(
          async () => (await gridText(page)) !== before,
          20_000,
        )) >= 0,
        "instrument grid ticking again",
      );
      check(
        (await waitUntil(async () => (await staleCount(page)) === 0, 20_000)) >=
          0,
        "stale markers cleared",
      );
      await waitUntil(async () => {
        const t = await ticketState(page);
        return !!t && !t.blocked && (!submitWasEnabled || !t.submitDisabled);
      }, 15_000);
      const after = await ticketState(page);
      check(
        after?.connectionState === "connected" &&
          !after.blocked &&
          (!submitWasEnabled || !after.submitDisabled),
        `ticket re-enabled ${JSON.stringify(after)}`,
      );
    }
    await shot("recovered");

    for (let i = 1; i <= portalRestarts; i++) {
      log(`--- portal restart ${i}/${portalRestarts}`);
      await stop(portal, "SIGKILL");
      const seen = new Set<string>();
      const track = async () => {
        const state = await indicatorState(page);
        if (state) seen.add(state);
        return state;
      };
      await waitUntil(async () => (await track()) !== "connected", 15_000);
      await Bun.sleep(3_000);
      portal = startPortal();
      await mustWait("portal port", () => portOpen(cfg.portalWsPort));
      const recoveredIn = await waitUntil(
        async () => (await track()) === "connected",
        90_000,
      );
      check(
        recoveredIn >= 0,
        `portal: indicator connected ${(recoveredIn / 1000).toFixed(1)}s after restart (states: ${[...seen].join(" -> ")})`,
      );
      const before = await gridText(page);
      check(
        (await waitUntil(
          async () => (await gridText(page)) !== before,
          20_000,
        )) >= 0,
        "portal: trading views still ticking",
      );
      check(!(await moduleError(page)), "portal: no remote module error");
    }

    const serverRefusals = (output.trading ?? []).filter((l) =>
      /maximum sessions/i.test(l),
    );
    const all = [...refusals, ...serverRefusals];
    check(
      all.length === 0,
      `no session-limit refusals after the restarts (${all.join(" | ") || "none"})`,
    );

    if (sessionLimit) {
      log("--- session limit: trading server with maxSessionsPerUser=1");
      await stop(trading);
      trading = startTrading({
        VUU_MAX_SESSIONS_PER_USER: "1",
        VUU_SESSION_LIMIT_POLICY: "reject-new",
      });
      await mustWait("trading port", () => portOpen(cfg.tradingWsPort));
      check(
        (await waitUntil(
          async () => (await indicatorState(page)) === "connected",
          90_000,
        )) >= 0,
        "limit: first tab reconnected",
      );
      const second = await context.newPage();
      const secondRefusals: string[] = [];
      second.on("websocket", (ws) =>
        ws.on("framereceived", ({ payload }) => {
          const text = String(payload);
          if (/maximum sessions/i.test(text)) secondRefusals.push(text);
        }),
      );
      await second.goto(`${cfg.hostOrigin}/workspaces/trader`);
      await waitUntil(async () => secondRefusals.length > 0, 60_000);
      check(
        secondRefusals.length > 0,
        "limit: second tab refused by the server",
      );
      await Bun.sleep(3_000);
      const refusedState = await indicatorState(second);
      check(
        refusedState === "reconnecting" ||
          refusedState === "connecting" ||
          refusedState === "disconnected",
        `limit: second tab shows it is not connected (${refusedState})`,
      );
      check(
        (await indicatorState(page)) === "connected",
        "limit: first tab unaffected (reject-new)",
      );
      log("closing the first tab");
      await page.close();
      const connectedIn = await waitUntil(
        async () => (await indicatorState(second)) === "connected",
        90_000,
      );
      if (connectedIn < 0)
        log(
          `second tab indicator: ${await second
            .locator(CONNECTION_STATUS_SELECTOR)
            .first()
            .evaluate((el) => el.outerHTML)
            .catch(() => "n/a")}`,
        );
      check(
        connectedIn >= 0,
        `limit: second tab connected ${(connectedIn / 1000).toFixed(1)}s after the first closed (${secondRefusals.length} refusals)`,
      );
      check(
        (await waitUntil(async () => (await gridRows(second)) > 0, 30_000)) >=
          0,
        "limit: second tab's grid populated",
      );
      check(!(await moduleError(second)), "limit: no remote module error");
      await second.screenshot({
        path: resolve(root, ".run/e2e-resilience-limit.png"),
      });
    }
    check(
      pageErrors.length === 0,
      `no uncaught page errors (${pageErrors.slice(0, 3).join(" | ") || "none"})`,
    );
  } catch (error) {
    await shot("error").catch(() => undefined);
    log(`console errors:\n${consoleErrors.slice(0, 10).join("\n---\n")}`);
    throw error;
  } finally {
    await browser.close();
  }
};

await run(main);
