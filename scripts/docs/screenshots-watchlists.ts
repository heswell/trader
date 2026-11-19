/**
 * bun ./scripts/docs/screenshots-watchlists.ts [showcase url]
 *
 * Takes the watchlist and column-set screenshots in docs/screenshots from a
 * running showcase (default http://localhost:5001, `bun run dev:showcase`):
 * - watchlist-dialog-{light,dark}: New watchlist, Energy sector, a few picked
 * - instrument-grid-scoped-sets: a watchlist with its own pinned column set,
 *   and a quick filter value Also applied on a set that doesn't show it
 */
import { resolve } from "node:path";
import { chromium, type Page } from "playwright";

const root = resolve(import.meta.dir, "../..");
const base = process.argv[2] ?? "http://localhost:5001";
const out = (name: string) => resolve(root, `docs/screenshots/${name}.png`);

const fresh = async (page: Page, mode: "light" | "dark", lists: unknown) => {
  await page.goto(`${base}/?mode=${mode}#instrument-grid`);
  await page.evaluate((watchlists) => {
    for (const key of Object.keys(localStorage))
      if (key.startsWith("trading.instrumentGrid"))
        localStorage.removeItem(key);
    localStorage.setItem("trading.watchlists", JSON.stringify(watchlists));
  }, lists);
  await page.reload();
  await page.locator(".tradingInstrumentGrid .vuuTableRow").nth(5).waitFor();
};

const dialog = async (page: Page, mode: "light" | "dark") => {
  await fresh(page, mode, { lists: [] });
  await page
    .getByRole("button", { name: "Instruments: All instruments" })
    .click();
  await page.getByRole("menuitem", { name: /New watchlist/ }).click();
  await page.getByRole("textbox", { name: "Name" }).fill("Energy majors");
  await page.getByRole("combobox", { name: "Sector" }).click();
  await page.getByRole("option", { exact: true, name: "Energy" }).click();
  await page.keyboard.press("Escape");
  const search = page.getByRole("combobox", { name: "Search by RIC or name" });
  await search.focus();
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("Enter");
    await page.keyboard.press("ArrowDown");
  }
  await page.waitForTimeout(400);
  await page.locator(".tradingWatchlistDialog").screenshot({
    path: out(`watchlist-dialog-${mode}`),
  });
  console.log(`docs/screenshots/watchlist-dialog-${mode}.png`);
};

const scopedSets = async (page: Page) => {
  await fresh(page, "light", {
    lists: [
      {
        id: "banks",
        name: "Banks",
        rics: ["BARC.L", "HSBA.L", "LLOY.L", "NWG.L", "STAN.L"],
      },
    ],
  });
  await page
    .getByRole("button", { name: "Instruments: All instruments" })
    .click();
  await page.getByRole("menuitemradio", { name: /Banks/ }).click();
  // a value on Exchange, then a Banks-only set that doesn't show it
  const exchange = page.locator(
    '.vuuQuickFilters-filter[data-field="exchange"] input',
  );
  await exchange.fill("XLON");
  await exchange.press("Enter");
  // from Screening (no Exchange field): the new set keeps its fields, so
  // XLON shows as Also applied
  await page.getByRole("tab", { name: /^Screening/ }).click();
  await page.getByRole("button", { name: "New column set" }).click();
  await page.getByRole("textbox", { name: "Name" }).fill("Bank view");
  await page.getByRole("radio", { name: "Only Banks" }).check();
  await page.getByRole("button", { name: "Create" }).click();
  await page.mouse.move(0, 0);
  await page.waitForTimeout(1500);
  await page.locator(".showcaseApp-example").screenshot({
    path: out("instrument-grid-scoped-sets"),
  });
  console.log("docs/screenshots/instrument-grid-scoped-sets.png");
};

const browser = await chromium.launch();
try {
  for (const mode of ["light", "dark"] as const) {
    const page = await browser.newPage({
      viewport: { width: 1300, height: 760 },
      deviceScaleFactor: 1,
    });
    await dialog(page, mode);
    await page.close();
  }
  const page = await browser.newPage({
    viewport: { width: 1300, height: 420 },
    deviceScaleFactor: 1,
  });
  await scopedSets(page);
  await page.close();
} finally {
  await browser.close();
}
