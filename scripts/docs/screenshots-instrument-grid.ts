/**
 * bun ./scripts/docs/screenshots-instrument-grid.ts [showcase url]
 *
 * Takes the InstrumentGrid screenshots in docs/screenshots, light and dark,
 * from a running showcase (default http://localhost:5001, `bun run dev:showcase`):
 * a linked, pinned row (ADM.L, Red), a selected row with its actions, the
 * filter bar and the footer.
 */
import { resolve } from "node:path";
import { chromium, type Page } from "playwright";

const root = resolve(import.meta.dir, "../..");
const base = process.argv[2] ?? "http://localhost:5001";

const stage = async (page: Page, mode: "light" | "dark") => {
  await page.goto(`${base}/?mode=${mode}#instrument-grid`);
  const rows = page.locator(".tradingInstrumentGrid .vuuTableRow");
  await rows.nth(5).waitFor();
  // link ADM.L to Red: it pins above the other rows
  await page.getByRole("button", { name: "Link ADM.L to a channel" }).click();
  await page.getByRole("menuitem", { name: /^Red/ }).first().click();
  await page.locator(".vuuTable-pinnedRows .vuuTableRow").first().waitFor();
  // select ABF.L: its Buy / Sell / Depth show
  await page
    .locator('.vuuTableRow:has([data-ric="ABF.L"]) .vuuTableCell')
    .nth(2)
    .click();
  await page.mouse.move(0, 0);
  // let a few prices tick and the sparklines fill
  await page.waitForTimeout(2500);
};

const browser = await chromium.launch();
try {
  for (const mode of ["light", "dark"] as const) {
    const page = await browser.newPage({
      viewport: { width: 1500, height: 640 },
      deviceScaleFactor: 1,
    });
    await stage(page, mode);
    await page.locator(".showcaseApp-example").screenshot({
      path: resolve(root, `docs/screenshots/instrument-grid-${mode}.png`),
    });
    await page.close();
    console.log(`docs/screenshots/instrument-grid-${mode}.png`);
  }
} finally {
  await browser.close();
}
