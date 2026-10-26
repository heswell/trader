/**
 * bun run e2e:palette [--no-build] [--headed]
 *
 * Opt-in end-to-end check of the workspace Panels palette (not part of CI: it
 * needs Keycloak). Starts its own stack and, in headless Chromium:
 *
 *  alice, Workspaces › Trader (the system workspace):
 *   1. Add panel opens the Panels palette in the shell context panel, with
 *      the Modules and Recent tabs only (no Tables), modules grouped
 *      Trading / Market / Portfolio,
 *   2. + adds an Order ticket (red), which makes the personal copy,
 *   3. clicking a row with more than one panel prompts: Esc cancels, T opens
 *      it as a new tab,
 *   4. dragging a row shows the drop compass: a panel edge splits (hint bar,
 *      no prompt), the centre stacks it as a tab (on a narrow panel's compact
 *      compass, a drop in the gap around the centre tile too), and the centre
 *      (gap included) is disabled on a panel already in a stack,
 *   5. the added panels survive a reload and are listed under Recent,
 *   6. Reset to default restores the eight default panels,
 *   7. the Trader brand goes to the portal root, from a workspace and from a
 *      module page,
 *   8. the nav footer's hover is neutral, not the theme's coral: the user
 *      menu trigger, its items and the connection status (upstream 100).
 *  alice, + New workspace: Trader's empty content (its button opens the
 *   palette), click adds (0 panels), click replaces (1 panel), + adds; a
 *   palette Time & sales shows its picker.
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
const COMPASS = ".vuuDropCompass";
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

/** The panel (grid item) whose header title or selected stack tab is `title`. */
const panelBox = async (page: Page, title: string) => {
  const box = await page
    .locator(ITEM, {
      has: page.locator(".vuuGridLayoutItemHeader-title", {
        hasText: new RegExp(`^${title}$`),
      }),
    })
    .boundingBox();
  if (!box) throw Error(`no ${title} panel`);
  return box;
};

/** The visible compass: its active zone and whether its centre is disabled. */
const compassState = (page: Page) =>
  page.evaluate((selector) => {
    const compass = document.querySelector<HTMLElement>(selector);
    return compass
      ? {
          activeZone: compass.dataset.activeZone,
          centreDisabled: !!compass.querySelector(
            "[data-compass-zone=centre][data-disabled]",
          ),
        }
      : undefined;
  }, COMPASS);

/**
 * A point in the gap between the compass's centre and north tiles (the zone
 * resolved to an edge there before @vuu-ui alpha.31, upstream 110).
 */
const compassGapPoint = (page: Page) =>
  page.evaluate((selector) => {
    const tile = (zone: string) =>
      document
        .querySelector(`${selector} [data-compass-zone=${zone}]`)
        ?.getBoundingClientRect();
    const centre = tile("centre");
    const north = tile("north");
    const compass = document.querySelector(selector);
    if (!centre || !north || !compass) return undefined;
    return {
      x: centre.left + centre.width / 2,
      y: (north.bottom + centre.top) / 2,
      gap: centre.top - north.bottom,
      compact: compass.classList.contains("vuuDropCompass-compact"),
    };
  }, COMPASS);

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
    const tabs = await page.locator(".vuuPanelsPalette-tab").allTextContents();
    log(`palette tabs: ${tabs.join(", ")}`);
    check(
      tabs.join() === "Modules,Recent",
      "the palette offers Modules and Recent only (no Tables)",
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

    // 4. drag: the compass; an edge splits, without a prompt
    await openPalette(page);
    const target = await panelBox(page, "Instruments");
    let hint = "";
    let edge: Awaited<ReturnType<typeof compassState>>;
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
        edge = await compassState(page);
        await shot("drag");
      },
    );
    log(`drag hint: ${hint}; compass: ${JSON.stringify(edge)}`);
    check(hint.includes("Drop on a panel edge"), "drag shows the hint bar");
    check(edge?.activeZone === "south", "the compass shows the south edge");
    await waitItems(page, "drag Exposure", DEFAULT_PANELS + 3);
    check(
      (await page.getByLabel("Open Exposure").count()) === 0,
      "drag places Exposure without a prompt",
    );
    check(
      (await page.locator(COMPASS).count()) === 0,
      "the compass is gone after the drop",
    );

    // the centre is disabled on a panel already in a stack (Orders / Fills / …)
    await openPalette(page);
    const stacked = await page
      .locator(".vuuPortalWorkspace [role=tab]", { hasText: /^Orders$/ })
      .first()
      .evaluate((tab) => {
        const r = (
          tab.closest(".vuuGridLayoutItem") ?? tab
        ).getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      });
    const before = await itemCount(page);
    let centreOfStack: Awaited<ReturnType<typeof compassState>>;
    let gapOfStack: Awaited<ReturnType<typeof compassState>>;
    await dragRowTo(
      page,
      "Positions",
      { x: stacked.x + stacked.width / 2, y: stacked.y + stacked.height / 2 },
      async () => {
        centreOfStack = await compassState(page);
        await shot("compass-disabled");
        const gap = await compassGapPoint(page);
        if (gap) {
          await page.mouse.move(gap.x, gap.y, { steps: 4 });
          await Bun.sleep(300);
          gapOfStack = await compassState(page);
        }
        await page.keyboard.press("Escape");
      },
    );
    log(
      `compass over a stack: ${JSON.stringify(centreOfStack)}; gap: ${JSON.stringify(gapOfStack)}`,
    );
    check(
      centreOfStack?.centreDisabled === true,
      "the compass centre is disabled on a panel already in a stack",
    );
    check(
      gapOfStack?.centreDisabled === true &&
        !["north", "south", "east", "west"].includes(
          gapOfStack.activeZone ?? "",
        ),
      "the gap around a stacked panel's (disabled) centre does not resolve to an edge",
    );
    await Bun.sleep(500);
    check(
      (await itemCount(page)) === before,
      "Esc cancels the drag (no change)",
    );

    // the centre stacks the panel as a tab (alpha.30: no longer replaces).
    // Tape is narrow, so its compass is compact: the gap around the centre
    // tile resolves to the centre (alpha.31, 110), and the drop is made there.
    await openPalette(page);
    const tapeBox = await panelBox(page, "Tape");
    let centre: Awaited<ReturnType<typeof compassState>>;
    let gap: Awaited<ReturnType<typeof compassGapPoint>>;
    await dragRowTo(
      page,
      "Execution quality",
      { x: tapeBox.x + tapeBox.width / 2, y: tapeBox.y + tapeBox.height / 2 },
      async () => {
        gap = await compassGapPoint(page);
        if (gap) {
          await page.mouse.move(gap.x, gap.y, { steps: 4 });
          await Bun.sleep(300);
        }
        centre = await compassState(page);
        await shot("compass-centre");
      },
    );
    log(`compass gap ${JSON.stringify(gap)}: ${JSON.stringify(centre)}`);
    check(gap?.compact === true, "a narrow panel has a compact compass");
    check(
      centre?.activeZone === "centre" && !centre.centreDisabled,
      "the gap around the compact compass's centre tile resolves to the centre",
    );
    await waitItems(page, "centre Execution quality", DEFAULT_PANELS + 4);
    const stackTabs = await page
      .locator(".vuuPortalWorkspace [role=tab]", {
        hasText: /^Execution quality$/,
      })
      .evaluate((tab) =>
        [
          ...(tab.closest("[role=tablist]")?.querySelectorAll("[role=tab]") ??
            []),
        ].map((t) => t.textContent ?? ""),
      )
      .catch(() => [] as string[]);
    log(`stack: ${stackTabs.join(", ")}`);
    check(
      stackTabs.includes("Tape") && stackTabs.includes("Execution quality"),
      "a centre drop stacks the panel as a tab with Tape (no replace)",
    );
    await mustWait("panel titles rendered", async () =>
      (await panelTitles(page)).every(Boolean),
    );
    const editedTitles = await panelTitles(page);
    await shot("edited");

    // 5. reload and Recent
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForWorkspace(page, "after reload");
    await mustWait(
      "panels after reload",
      async () => (await itemCount(page)) === DEFAULT_PANELS + 4,
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
      ["Order ticket", "P&L", "Exposure", "Execution quality"].every((l) =>
        recent.includes(l),
      ),
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

    // 7. the brand goes to the portal root, from a workspace and a module page
    const brand = page.getByRole("link", { name: "Trader home" });
    await brand.click();
    await mustWait("brand → /", () => new URL(page.url()).pathname === "/");
    check(true, "the brand goes to the portal root from a workspace");
    await page
      .locator(".vuuPortalNav-label", { hasText: /^Watchlist$/ })
      .click();
    await mustWait("Watchlist page", () =>
      page.url().endsWith("/trading/watchlist"),
    );
    await brand.click();
    await mustWait("brand → /", () => new URL(page.url()).pathname === "/");
    check(true, "the brand goes to the portal root from a module page");
    const home = await waitUntil(
      async () =>
        (await page.locator(".vuuPortalLandingPage .traderHome h1").count()) ===
        1,
      5_000,
    );
    check(home >= 0, "the portal root shows Trader's home page");
    await shot("root");

    // 8. the nav footer hovers are neutral (alpha.31, 100)
    const hoverBackground = async (selector: string) => {
      const el = page.locator(selector).first();
      await el.hover();
      await Bun.sleep(400);
      return el.evaluate((e) => getComputedStyle(e).backgroundColor);
    };
    const isNeutral = (colour: string) => {
      const [r, g, b, a = 1] = (colour.match(/[\d.]+/g) ?? []).map(Number);
      // coral is rgb(243, 120, 128); neutral means grey (r = g = b) or clear
      return a === 0 || (r === g && g === b);
    };
    const footer: Record<string, string> = {};
    footer.status = await hoverBackground(".vuuPortalConnectionStatus-trigger");
    footer.trigger = await hoverBackground(".vuuPortalNavUserMenu-trigger");
    await page.locator(".vuuPortalNavUserMenu-trigger").click();
    await page.locator(".vuuPortalNavUserMenu-panel").waitFor();
    footer.open = await page
      .locator(".vuuPortalNavUserMenu-trigger")
      .evaluate((e) => getComputedStyle(e).backgroundColor);
    footer.item = await hoverBackground(
      '.vuuPortalNavUserMenu-item[role=menuitem]:not([aria-disabled="true"])',
    );
    await shot("footer-hover");
    await page.keyboard.press("Escape");
    log(`nav footer hover: ${JSON.stringify(footer)}`);
    check(
      Object.values(footer).every(
        (c) => c !== "rgb(243, 120, 128)" && isNeutral(c),
      ),
      "the nav footer hover / open backgrounds are neutral, not coral",
    );
    check(
      footer.trigger !== "rgba(0, 0, 0, 0)",
      "the user menu trigger has a visible hover background",
    );

    // ---- alice: + New workspace ---------------------------------------------
    await page
      .locator(".vuuPortalNav-label", { hasText: "New workspace" })
      .click();
    await mustWait("new workspace route", () =>
      /\/workspaces\/workspace-/.test(page.url()),
    );
    await page.getByText("This workspace is empty").waitFor();
    check(
      (await page.locator(".vuuWorkspaceDropZone").innerText()).includes(
        "Drag a module from the Panels palette",
      ),
      "a new workspace shows Trader's empty content",
    );
    await openPalette(page);
    await shot("blank");
    await page
      .locator(".vuuContextPanel")
      .getByRole("button", { name: /close/i })
      .first()
      .click();
    await mustWait(
      "palette closed",
      async () =>
        !(await page
          .locator(PALETTE)
          .isVisible()
          .catch(() => false)),
    );
    await page.getByRole("button", { name: "Open Panels palette" }).click();
    await page.locator(PALETTE).waitFor();
    check(true, "the empty content's button opens the palette");
    await Bun.sleep(1_500);
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
      (await waitUntil(
        async () =>
          (await tape.locator("input[placeholder='Search ric']").count()) > 0,
        20_000,
      )) >= 0,
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
