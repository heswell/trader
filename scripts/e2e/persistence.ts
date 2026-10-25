/**
 * bun run e2e:persistence [--no-build] [--headed]
 *
 * Opt-in end-to-end persistence check (not part of CI: it needs Keycloak and
 * takes a few minutes). Starts its own stack with the trading server
 * persisting to a fresh temp dir (file store, background order flow off), and
 * as alice in headless Chromium:
 *
 *  1. places a marketable BUY 100 AAPL.OQ (fills) and a resting BUY 200 below
 *     the market (stays working) from the order ticket,
 *  2. reads the working order and alice's AAPL.OQ position,
 *  3. kills the trading server with SIGKILL (a crash: no final snapshot) and
 *     starts it again on the same data dir,
 *  4. without reloading the page (the UI reconnects and resubscribes on its
 *     own, see docs/resilience.md) checks the same position and the same
 *     working order are shown, the server log reports the recovery with 0
 *     discrepancies, and a new order gets the next order id.
 *
 * Ports and Keycloak as for e2e:resilience (scripts/e2e/harness.ts). The temp
 * data dir is removed at the end. Screenshots go to .run/.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Page } from "playwright";
import {
  check,
  indicatorState,
  log,
  login,
  moduleError,
  mustWait,
  output,
  root,
  run,
  setLogTag,
  startStack,
  stop,
  waitUntil,
  flag,
} from "./harness";

setLogTag("e2e persistence");

const RIC = "AAPL.OQ";
const ACCOUNT = "ACC-US-01";

const rowTexts = (page: Page, scope = "") =>
  page.evaluate(
    (scope) =>
      [...document.querySelectorAll(`${scope} [role=row]`)].map((r) =>
        (r as HTMLElement).innerText.replace(/\s+/g, " ").trim(),
      ),
    scope,
  );

/** Working-order rows (workspace blotter) for the test instrument. */
const workingOrders = async (page: Page) =>
  (await rowTexts(page)).filter((r) => r.includes("AAPL") && /\bO-\d+/.test(r));

const orderIds = (rows: string[]) =>
  rows.flatMap((r) => r.match(/\bO-\d+\b/g) ?? []);

/** The ticket's instrument search (the ladder panel has its own picker). */
const TICKET_SEARCH =
  ".tradingOrderTicket input[placeholder='Search instrument']";

/** Opens Workspaces › Trader (the system workspace) and waits for the ticket. */
const openWorkspace = async (page: Page) => {
  for (let attempt = 0; attempt < 4; attempt++) {
    await page
      .locator(".vuuPortalNav-label", { hasText: /^Trader$/ })
      .click({ timeout: 10_000 })
      .catch(() => undefined);
    const ready = await waitUntil(
      async () =>
        !(await moduleError(page)) &&
        (await page.locator(TICKET_SEARCH).count()) > 0,
      20_000,
    );
    if (ready >= 0) return;
    log(`workspace not ready (attempt ${attempt + 1}), reloading`);
    await page.reload({ waitUntil: "domcontentloaded" });
  }
  throw Error("workspace did not load");
};

/** Selects a workspace blotter tab, retrying until it reports selected. */
const selectTab = async (page: Page, name: string) => {
  const tab = page.getByRole("tab", { name });
  await mustWait(`${name} tab selected`, async () => {
    if ((await tab.getAttribute("aria-selected")) === "true") return true;
    await tab.click().catch(() => undefined);
    await Bun.sleep(300);
    return false;
  });
};

/**
 * The workspace blotter's Positions tab, grouped currency / sector / account /
 * ric: expands the collapsed group rows until the leaf rows show.
 */
const openPositions = async (page: Page) => {
  await selectTab(page, "Positions");
  await mustWait("positions grouped rows", async () =>
    (await rowTexts(page)).includes("USD"),
  );
  await expandGroups(page);
};

const expandGroups = async (page: Page) => {
  for (let level = 0; level < 4; level++) {
    const collapsed = page.locator(
      "[role=row][aria-expanded=false] .vuuTableGroupCell button",
    );
    const count = await collapsed.count();
    if (count === 0) break;
    for (let i = 0; i < count; i++)
      await collapsed
        .first()
        .click()
        .catch(() => undefined);
    await Bun.sleep(500);
  }
};

/** alice's position leaf row as "+100 Long @ 174.75" (the live mark is left out). */
const positionRow = async (page: Page) => {
  const row = (await rowTexts(page)).find(
    (r) => r.startsWith(ACCOUNT) && r.includes(RIC),
  );
  const match = row?.match(/([+-]?[\d,]+) (Long|Short|Flat)(\d[\d,]*\.\d{2})/);
  return match ? `${match[1]} ${match[2]} @ ${match[3]}` : undefined;
};

const submitBuy = async (page: Page, qty: number, price: string) => {
  await page.locator("input[aria-label='Quantity']").fill(String(qty));
  const limit = page.locator("input[aria-label='Limit price']");
  await limit.fill(price);
  await limit.press("Tab");
  await page
    .getByRole("button", { name: new RegExp(`BUY ${qty} AAPL`, "i") })
    .click();
};

const main = async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "trader-e2e-persistence-"));
  const tradingEnv = {
    TRADER_PERSISTENCE_STORE: "file",
    TRADER_DATA_DIR: dataDir,
    OMS_FLOW_RATE: "0",
  };
  log(`trading data dir ${dataDir}`);
  const { cfg, trading, startTrading } = await startStack(tradingEnv);

  const browser = await chromium.launch({
    headless: !flag("headed"),
    args: ["--ignore-certificate-errors"],
  });
  const page = await (
    await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1600, height: 1000 },
    })
  ).newPage();
  page.setDefaultTimeout(15_000);
  const shot = (name: string) =>
    page.screenshot({
      path: resolve(root, `.run/e2e-persistence-${name}.png`),
    });

  try {
    await page.goto(`${cfg.hostOrigin}/workspaces/trader`);
    await login(page);
    await mustWait(
      "indicator connected",
      async () => (await indicatorState(page)) === "connected",
      60_000,
    );
    await openWorkspace(page);

    // ---- 1. a fill and a resting order ------------------------------------
    await page.locator(TICKET_SEARCH).fill("AAPL");
    await page.locator("[role=option]", { hasText: RIC }).first().click();
    let ask = Number.NaN;
    await mustWait("best ask", async () => {
      const text = await page.evaluate(() => document.body.innerText);
      ask = Number(text.match(/\bASK\s+([\d.]+)/)?.[1]);
      return ask > 0;
    });
    const restingPrice = (Math.floor(ask * 0.98 * 20) / 20).toFixed(2);
    log(
      `ask ${ask}: BUY 100 @ ${(ask + 0.5).toFixed(2)}, BUY 200 @ ${restingPrice}`,
    );
    await submitBuy(page, 100, (ask + 0.5).toFixed(2));
    await Bun.sleep(1_500);
    await submitBuy(page, 200, restingPrice);
    await mustWait(
      "resting order in the blotter",
      async () =>
        (await workingOrders(page)).some((r) => r.includes(restingPrice)),
      20_000,
    );
    const ordersBefore = await workingOrders(page);
    const idsBefore = orderIds(ordersBefore);
    log(`working before: ${ordersBefore.join(" | ")}`);
    check(idsBefore.length === 1, `one working order before (${idsBefore})`);
    await shot("before-orders");

    // ---- 2. the position ------------------------------------------------------
    await openPositions(page);
    await mustWait("position row", async () => !!(await positionRow(page)));
    const positionBefore = (await positionRow(page)) ?? "";
    log(`position before: ${positionBefore}`);
    check(
      positionBefore.startsWith("+100 Long"),
      "position +100 Long before the crash",
    );
    await shot("before-position");

    // ---- 3. crash and restart -------------------------------------------------
    const tradingLog = output.trading ?? [];
    const logFrom = tradingLog.length;
    log("SIGKILL the trading server");
    await stop(trading, "SIGKILL");
    await mustWait(
      "indicator not connected",
      async () => (await indicatorState(page)) !== "connected",
      30_000,
    );
    const restarted = startTrading();
    await mustWait(
      "trading restored",
      () => {
        if (restarted.exitCode !== null)
          throw Error(`trading exited:\n${tradingLog.slice(-20).join("\n")}`);
        return tradingLog
          .slice(logFrom)
          .some((l) => l.includes("restored from"));
      },
      120_000,
    );
    const report =
      tradingLog.slice(logFrom).find((l) => l.includes("restored from")) ?? "";
    log(`trading: ${report}`);
    check(/file:/.test(report), "recovered from the file store");
    check(/ 1 working orders/.test(report), "1 working order recovered");
    check(/ 0 discrepancies/.test(report), "reconciliation: 0 discrepancies");

    // ---- 4. the UI shows the same state after reconnecting -------------------
    const reconnectedIn = await waitUntil(
      async () => (await indicatorState(page)) === "connected",
      90_000,
    );
    check(reconnectedIn >= 0, "UI reconnected without a reload");
    const sameState = async (when: string, timeoutMs: number) => {
      await openPositions(page);
      const positionMatches = await waitUntil(async () => {
        await expandGroups(page);
        return (await positionRow(page)) === positionBefore;
      }, timeoutMs);
      log(`position ${when}: ${(await positionRow(page)) ?? "(none)"}`);
      await shot(`${when.replace(/\W+/g, "-")}-position`);
      await selectTab(page, "Orders");
      const ordersMatch = await waitUntil(async () => {
        const rows = await workingOrders(page);
        return (
          JSON.stringify(orderIds(rows)) === JSON.stringify(idsBefore) &&
          rows.some((r) => r.includes(restingPrice))
        );
      }, timeoutMs);
      log(`working ${when}: ${(await workingOrders(page)).join(" | ")}`);
      return { position: positionMatches >= 0, orders: ordersMatch >= 0 };
    };
    const live = await sameState("after reconnect", 30_000);
    check(live.position, "same position after reconnect (no reload)");
    check(live.orders, "same working order after reconnect (no reload)");

    // and from a fresh page load

    log("reloading the page");
    await page.reload({ waitUntil: "domcontentloaded" });
    await mustWait(
      "indicator connected after reload",
      async () => (await indicatorState(page)) === "connected",
      60_000,
    );
    await openWorkspace(page);
    const reloaded = await sameState("after reload", 30_000);
    check(reloaded.position, "same position after the restart (reload)");
    check(reloaded.orders, "same working order after the restart (reload)");

    // ---- 5. order ids continue ------------------------------------------------
    const nextPrice = (Math.floor(ask * 0.97 * 20) / 20).toFixed(2);
    // The ticket can still be settling after the reload, so one resubmit is
    // allowed; any extra order only gets a higher id.
    let placed = false;
    for (let attempt = 1; attempt <= 2 && !placed; attempt++) {
      await page.locator(TICKET_SEARCH).fill("AAPL");
      await page.locator("[role=option]", { hasText: RIC }).first().click();
      await submitBuy(page, 300, nextPrice);
      placed =
        (await waitUntil(
          async () => orderIds(await workingOrders(page)).length > 1,
          15_000,
        )) >= 0;
      if (!placed) log(`new order not in the blotter (attempt ${attempt})`);
    }
    if (!placed) {
      await shot("new-order-missing");
      throw Error("new order in the blotter: timeout");
    }
    const newIds = orderIds(await workingOrders(page)).filter(
      (id) => !idsBefore.includes(id),
    );
    const maxBefore = Math.max(
      ...idsBefore.map((id) => Number(id.slice(2))),
      2,
    );
    log(`new order ids: ${newIds}`);
    check(
      newIds.length === 1 && Number(newIds[0].slice(2)) > maxBefore,
      `new order id continues the sequence (${newIds} > O-${maxBefore})`,
    );
    await shot("after-orders");
    check(!(await moduleError(page)), "no remote module error");
  } catch (error) {
    await shot("error").catch(() => undefined);
    throw error;
  } finally {
    await browser.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
};

await run(main);
