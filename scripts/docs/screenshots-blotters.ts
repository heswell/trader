/**
 * bun ./scripts/docs/screenshots-blotters.ts [showcase url]
 *
 * Takes the Orders and Fills blotter screenshots in docs/screenshots, light
 * and dark, from a running showcase (default http://localhost:5001,
 * `bun run dev:showcase`). On each, the first row's instrument is linked to
 * Red through the row context menu, so its rows show the channel marker and
 * the footer shows its chip.
 */
import { resolve } from "node:path";
import { chromium, type Page } from "playwright";

const root = resolve(import.meta.dir, "../..");
const base = process.argv[2] ?? "http://localhost:5001";

const linkFirstRowToRed = async (page: Page, rows: string) => {
  const row = page.locator(`${rows}:not(.vuuRowProxy)`).first();
  await row.waitFor();
  await row.locator(".vuuTableCell").nth(3).click({ button: "right" });
  await page.getByRole("menuitem", { name: /^Link .* to$/ }).hover();
  await page.getByRole("menuitem", { name: /^Red/ }).click();
  await page.mouse.move(0, 0);
};

const shots: {
  name: string;
  hash: string;
  stage: (page: Page) => Promise<void>;
}[] = [
  {
    name: "orders",
    hash: "order-blotter",
    stage: async (page) => {
      await page.getByRole("radio", { name: "All" }).click();
      await linkFirstRowToRed(page, ".tradingOrderBlotter-table .vuuTableRow");
    },
  },
  {
    name: "fills",
    hash: "fills-blotter",
    stage: async (page) => {
      // grouped by RIC / side (the example's default): open the first
      // RIC and its side, then link from a fill row
      const rows = page.locator(
        ".tradingFillsBlotter-table .vuuTableRow:not(.vuuRowProxy)",
      );
      await rows.first().waitFor();
      await rows.nth(0).locator(".vuuTableCell").first().click();
      await rows.nth(1).locator(".vuuTableCell").first().click();
      await rows.nth(2).waitFor();
      await rows
        .nth(2)
        .locator(".vuuTableCell")
        .nth(3)
        .click({ button: "right" });
      await page.getByRole("menuitem", { name: /^Link .* to$/ }).hover();
      await page.getByRole("menuitem", { name: /^Red/ }).click();
      await page.mouse.move(0, 0);
    },
  },
];

const browser = await chromium.launch();
try {
  for (const { name, hash, stage } of shots) {
    for (const mode of ["light", "dark"] as const) {
      const page = await browser.newPage({
        viewport: { width: 1500, height: 640 },
        deviceScaleFactor: 1,
      });
      await page.goto(`${base}/?mode=${mode}#${hash}`);
      await stage(page);
      // let a few orders tick
      await page.waitForTimeout(2000);
      const path = `docs/screenshots/${name}-blotter-${mode}.png`;
      await page
        .locator(".showcaseApp-example")
        .screenshot({ path: resolve(root, path) });
      await page.close();
      console.log(path);
    }
  }
} finally {
  await browser.close();
}
