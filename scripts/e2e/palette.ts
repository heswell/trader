/**
 * bun run e2e:palette [--no-build] [--headed]
 *
 * Opt-in end-to-end check of the workspace Panels palette (not part of CI: it
 * needs Keycloak). Starts its own stack and, in headless Chromium:
 *
 *  alice, Workspaces › Trader (the system workspace):
 *   1. Add panel opens the Panels palette in the shell context panel, modules
 *      grouped Trading / Market / Portfolio,
 *   2. + adds an Order ticket (red), which makes the personal copy,
 *   3. clicking a row with more than one panel prompts: Esc cancels, T opens
 *      it as a new tab,
 *   4. dragging a row onto a panel edge places it (hint bar, no prompt),
 *   5. the added panels survive a reload and are listed under Recent,
 *   6. Reset to default restores the eight default panels.
 *  alice, + New workspace: the empty drop zone, click adds (0 panels), click
 *   replaces (1 panel), + adds; a palette Time & sales shows its picker.
 *  dave (view only) and sam (view + supervisor): no Order ticket or Price
 *   ladder rows (they need trading-execute), and no Desk overview for sam.
 *
 * Ports and Keycloak as for e2e:resilience (scripts/e2e/harness.ts).
 * Screenshots go to .run/.
 */
import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import {
  check,
  flag,
  indicatorState,
  log,
  login,
  moduleError,
  mustWait,
  root,
  run,
  setLogTag,
  startStack,
  waitUntil,
} from "./harness";

setLogTag("e2e palette");

const GROUPS = {
  Trading: [
    "Watchlist",
    "Orders",
    "Executions",
    "Price ladder",
    "Order ticket",
  ],
  Market: ["Market depth", "Time & sales", "Chart", "Depth chart"],
  Portfolio: ["Positions", "P&L", "Exposure", "Execution quality"],
};
const EXECUTE_ONLY = ["Order ticket", "Price ladder"];
const DEFAULT_PANELS = 8;

const PALETTE = ".vuuPanelsPalette";
const ITEM = ".vuuPortalWorkspace .vuuGridLayoutItem";
const HEADER = ".vuuPortalWorkspaceHeader";

/** Workspace panel titles: item headers plus stack tabs (not tabs inside a panel). */
const panelTitles = (page: Page) =>
  page.evaluate(() => {
    const ws = document.querySelector(".vuuPortalWorkspace");
    if (!ws) return [];
    const headers = [
      ...ws.querySelectorAll(".vuuGridLayoutItemHeader-title"),
    ].map((e) => e.textContent ?? "");
    const tabs = [...ws.querySelectorAll("[role=tab]")]
      .filter((t) => !t.closest(".vuuGridLayoutItemContent"))
      .map((t) => t.textContent ?? "");
    return [...headers, ...tabs].sort();
  });

const itemCount = (page: Page) => page.locator(ITEM).count();
const headerText = async (page: Page) =>
  (await page.locator(HEADER).textContent()) ?? "";

/** Palette group → row labels, as rendered. */
const paletteGroups = (page: Page) =>
  page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll(".vuuPanelsPalette-group")].map((g) => [
        g.querySelector(".vuuPanelsPalette-groupHeader")?.textContent?.trim(),
        [...g.querySelectorAll(".vuuPanelsPalette-label")].map(
          (l) => l.textContent ?? "",
        ),
      ]),
    ),
  );

const paletteLabels = async (page: Page) =>
  Object.values(await paletteGroups(page)).flat();

const row = (page: Page, label: string) =>
  page.locator(".vuuPanelsPalette-row", {
    has: page.locator(".vuuPanelsPalette-label", {
      hasText: new RegExp(`^${label.replace(/[&]/g, "\\$&")}$`),
    }),
  });

/** Opens the palette unless it is open (or opening: a new workspace opens it). */
const openPalette = async (page: Page) => {
  const visible = () =>
    page
      .locator(PALETTE)
      .isVisible()
      .catch(() => false);
  if ((await waitUntil(visible, 2_000)) < 0)
    await page.getByRole("button", { name: "Add panel" }).click();
  await page.locator(PALETTE).waitFor();
  // the context panel slides in; a drag started mid-transition selects text
  await Bun.sleep(1_500);
};

const selectTab = async (page: Page, name: string) =>
  page.locator(".vuuPanelsPalette-tab", { hasText: name }).click();

/** + on a palette row (shown on hover). */
const plus = async (page: Page, label: string) => {
  await openPalette(page);
  await row(page, label).hover();
  await row(page, label).locator(".vuuPanelsPalette-add").click();
};

const waitItems = (page: Page, what: string, n: number) =>
  mustWait(
    `${what}: ${n} panels`,
    async () => (await itemCount(page)) === n,
    20_000,
  );

/** Native HTML5 drag from a palette row to a point, in small steps. */
const dragRowTo = async (
  page: Page,
  label: string,
  to: { x: number; y: number },
  onHover?: () => Promise<void>,
) => {
  const from = await row(page, label).boundingBox();
  if (!from) throw Error(`no palette row ${label}`);
  await page.mouse.move(from.x + 40, from.y + from.height / 2);
  await page.mouse.down();
  const steps = 30;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(
      from.x + 40 + ((to.x - from.x - 40) * i) / steps,
      from.y +
        from.height / 2 +
        ((to.y - from.y - from.height / 2) * i) / steps,
    );
    await Bun.sleep(20);
  }
  await Bun.sleep(400);
  await onHover?.();
  await page.mouse.up();
};

const newPage = async (browser: Browser) => {
  const page = await (
    await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1600, height: 1000 },
    })
  ).newPage();
  page.setDefaultTimeout(15_000);
  return page;
};

const signIn = async (page: Page, origin: string, user: string) => {
  await page.goto(`${origin}/workspaces/trader`);
  await login(page, user);
  await mustWait(
    `${user}: indicator connected`,
    async () => (await indicatorState(page)) === "connected",
    60_000,
  );
  await waitForWorkspace(page, user);
};

const waitForWorkspace = async (page: Page, what: string) => {
  await page.locator(HEADER).waitFor({ timeout: 30_000 });
  await mustWait(
    `${what}: workspace panels`,
    async () => !(await moduleError(page)) && (await itemCount(page)) > 0,
    30_000,
  );
  await Bun.sleep(1_500);
};

const main = async () => {
  // in-memory trading state: independent of any dev stack's data dir lock
  const { cfg } = await startStack({ TRADER_PERSISTENCE_STORE: "memory" });
  const browser = await chromium.launch({
    headless: !flag("headed"),
    args: ["--ignore-certificate-errors"],
  });
  let page = await newPage(browser);
  const shot = (name: string) =>
    page.screenshot({ path: resolve(root, `.run/e2e-palette-${name}.png`) });

  try {
    // ---- alice: the Trader system workspace ---------------------------------
    await signIn(page, cfg.hostOrigin, "alice");
    check(
      (await headerText(page)).includes("Default"),
      "Trader opens as the system default",
    );
    check(
      (await itemCount(page)) === DEFAULT_PANELS,
      `${DEFAULT_PANELS} default panels`,
    );
    const defaultTitles = await panelTitles(page);

    // 1. the palette
    await openPalette(page);
    check(
      (await page.locator(`.vuuContextPanel-inline ${PALETTE}`).count()) > 0,
      "the palette is in the shell context panel, inline",
    );
    const groups = await paletteGroups(page);
    log(`palette: ${JSON.stringify(groups)}`);
    check(
      JSON.stringify(groups) === JSON.stringify(GROUPS),
      "modules grouped Trading / Market / Portfolio",
    );
    await shot("palette");

    // 2. + adds an Order ticket, on red, and makes the personal copy
    await plus(page, "Order ticket");
    await waitItems(page, "+ Order ticket", DEFAULT_PANELS + 1);
    await mustWait("personal copy", async () =>
      (await headerText(page)).includes("Your copy"),
    );
    check(true, "+ adds an Order ticket and makes the personal copy");
    const ticketPanels = page.locator(ITEM, {
      has: page.locator(".vuuGridLayoutItemHeader-title", {
        hasText: /^Order ticket$/,
      }),
    });
    check(
      (await ticketPanels.locator("button", { hasText: /^Red$/ }).count()) > 0,
      "the added Order ticket is on the red link group",
    );

    // 3. click with > 1 panel prompts; Esc cancels, T opens as a new tab
    await openPalette(page);
    await row(page, "P&L").locator(".vuuPanelsPalette-label").click();
    const prompt = page.getByLabel("Open P&L");
    await prompt.waitFor();
    const promptText = (await prompt.innerText()).replace(/\s+/g, " ");
    log(`prompt: ${promptText}`);
    check(
      /Replace \S/.test(promptText) && promptText.includes("Open as new tab"),
      "click prompts Replace <focused> / Open as new tab",
    );
    await shot("prompt");
    await page.keyboard.press("Escape");
    await mustWait("prompt closed", async () => (await prompt.count()) === 0);
    check(
      (await itemCount(page)) === DEFAULT_PANELS + 1,
      "Esc cancels the prompt (no change)",
    );
    await openPalette(page);
    await row(page, "P&L").locator(".vuuPanelsPalette-label").click();
    await prompt.waitFor();
    await page.keyboard.press("t");
    await mustWait("P&L as a new tab", async () =>
      (await panelTitles(page)).includes("P&L"),
    );
    check(
      (await itemCount(page)) === DEFAULT_PANELS + 2,
      "T opens P&L as a new tab",
    );

    // 4. drag onto a panel edge places it, without a prompt
    await openPalette(page);
    const target = await page
      .locator(ITEM, {
        has: page.locator(".vuuGridLayoutItemHeader-title", {
          hasText: /^Instruments$/,
        }),
      })
      .boundingBox();
    if (!target) throw Error("no Instruments panel");
    let hint = "";
    await dragRowTo(
      page,
      "Exposure",
      { x: target.x + target.width / 2, y: target.y + target.height - 12 },
      async () => {
        hint = (
          (await page.locator("body").innerText()).match(
            /Add\s+Exposure[\s\S]{0,80}/,
          )?.[0] ?? ""
        ).replace(/\s+/g, " ");
        await shot("drag");
      },
    );
    log(`drag hint: ${hint}`);
    check(hint.includes("Drop on a panel edge"), "drag shows the hint bar");
    await waitItems(page, "drag Exposure", DEFAULT_PANELS + 3);
    check(
      (await page.getByLabel("Open Exposure").count()) === 0,
      "drag places Exposure without a prompt",
    );
    const editedTitles = await panelTitles(page);
    await shot("edited");

    // 5. reload and Recent
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForWorkspace(page, "after reload");
    await mustWait(
      "panels after reload",
      async () => (await itemCount(page)) === DEFAULT_PANELS + 3,
      20_000,
    ).catch(() => undefined);
    check(
      JSON.stringify(await panelTitles(page)) === JSON.stringify(editedTitles),
      "the added panels survive a reload",
    );
    await openPalette(page);
    await selectTab(page, "Recent");
    const recent = await page
      .locator(".vuuPanelsPalette-label")
      .allTextContents();
    log(`recent: ${recent.join(", ")}`);
    check(
      ["Order ticket", "P&L", "Exposure"].every((l) => recent.includes(l)),
      "Recent lists the added panels",
    );
    await selectTab(page, "Modules");

    // 6. Reset to default
    await page.getByRole("button", { name: /Reset to default/i }).click();
    await page
      .locator(".vuuPortalWorkspaceReset")
      .getByRole("button", { name: /^Reset$/ })
      .click();
    await waitItems(page, "reset", DEFAULT_PANELS);
    await mustWait("Default badge", async () =>
      (await headerText(page)).includes("Default"),
    );
    check(
      JSON.stringify(await panelTitles(page)) === JSON.stringify(defaultTitles),
      "Reset to default restores the default panels",
    );

    // ---- alice: + New workspace ---------------------------------------------
    await page
      .locator(".vuuPortalNav-label", { hasText: "New workspace" })
      .click();
    await mustWait("new workspace route", () =>
      /\/workspaces\/workspace-/.test(page.url()),
    );
    await page.getByText("This workspace is empty").waitFor();
    check(true, "a new workspace shows the empty drop zone");
    await openPalette(page);
    await shot("blank");
    await row(page, "Watchlist").locator(".vuuPanelsPalette-label").click();
    await waitItems(page, "click Watchlist (0 panels)", 1);
    check(true, "click adds the first panel");
    await openPalette(page);
    await row(page, "Price ladder").locator(".vuuPanelsPalette-label").click();
    await mustWait(
      "Price ladder replaces Watchlist",
      async () => (await panelTitles(page)).join() === "Price ladder",
    );
    check((await itemCount(page)) === 1, "click with one panel replaces it");
    await plus(page, "Time & sales");
    await waitItems(page, "+ Time & sales", 2);
    const tape = page.locator(ITEM, {
      has: page.locator(".vuuGridLayoutItemHeader-title", {
        hasText: /^Time & sales$/,
      }),
    });
    check(
      (await tape.locator("input[placeholder='Search ric']").count()) > 0,
      "a palette Time & sales shows its instrument picker",
    );
    check(
      (await tape.locator("button", { hasText: /^Green$/ }).count()) > 0,
      "a palette Time & sales is on the green link group",
    );
    await shot("new-workspace");
    check(!(await moduleError(page)), "no remote module error (alice)");
    await page.context().close();

    // ---- dave and sam -------------------------------------------------------
    for (const user of ["dave", "sam"]) {
      page = await newPage(browser);
      await signIn(page, cfg.hostOrigin, user);
      await openPalette(page);
      const labels = await paletteLabels(page);
      log(`${user} palette: ${labels.join(", ")}`);
      const all = Object.values(GROUPS).flat();
      // neither has trading-execute; sam's Desk overview is not a palette module
      check(
        EXECUTE_ONLY.every((l) => !labels.includes(l)) &&
          all
            .filter((l) => !EXECUTE_ONLY.includes(l))
            .every((l) => labels.includes(l)) &&
          !labels.includes("Desk overview"),
        `${user}: no Order ticket or Price ladder, every other module`,
      );
      await shot(user);
      await page.context().close();
    }
  } catch (error) {
    await shot("error").catch(() => undefined);
    throw error;
  } finally {
    await browser.close();
  }
};

await run(main);
