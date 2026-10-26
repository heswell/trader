import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  createTradingTestData,
  type TradingTestData,
} from "@heswell/trading-test-data";
import { createTradingLocalServer } from "@heswell/trading-test-data/react";
import { act, cleanup, render } from "@testing-library/react";
import {
  AuthenticationProvider,
  type RemoteModuleDescriptor,
} from "@vuu-ui/core";
import { TRADING_FEATURES } from "../../features/trading/src/catalog";
import { navIconDataUri } from "../../features/trading/src/navIcons";
import { App } from "../src/App";

const modules: RemoteModuleDescriptor[] = TRADING_FEATURES.map((f) => ({
  accessRole: f.accessRole,
  clientIdentifier: f.name,
  description: f.description,
  id: f.id,
  mfComponent: f.expose,
  mfScope: f.mfScope,
  mfUrl: `http://features.test/${f.key}`,
  name: f.name,
  navBadge: f.navBadge,
  navIconUrl: f.navIcon ? navIconDataUri(f.navIcon) : undefined,
  navLocation: f.location,
  navOrder: f.navOrder,
  notificationTopics: f.notificationTopics && [...f.notificationTopics],
  path: f.path,
  title: f.title,
  version: 1,
  ...(f.workspace ? { workspace: f.workspace } : {}),
}));

// Every remote's config.json: the trading server, simulated in the browser.
const realFetch = globalThis.fetch;
const wait = (ms: number) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

describe("portal host", () => {
  let td: TradingTestData;

  beforeEach(() => {
    globalThis.fetch = (async () =>
      Response.json({ connectionId: "trading" })) as unknown as typeof fetch;
    td = createTradingTestData({ manualClock: true, oms: { flowRate: 0 } });
    td.advance(500);
  });

  afterEach(() => {
    cleanup();
    td.dispose();
    globalThis.fetch = realFetch;
    localStorage.clear();
  });

  const renderApp = async () => {
    await act(async () => {
      render(
        <AuthenticationProvider
          localServers={[createTradingLocalServer(td, "trading")]}
          mode="local"
          registry={{ modules }}
          user={{ userName: "alice" }}
        >
          <App environment="UAT" />
        </AuthenticationProvider>,
      );
    });
    await wait(300);
    const nav = document.querySelector(".vuuPortalShell > .vuuPortalNav");
    if (!nav) throw Error("PortalNav not rendered");
    return nav as HTMLElement;
  };

  const entry = (nav: HTMLElement, label: string) =>
    [...nav.querySelectorAll<HTMLElement>(".vuuPortalNav-link")].find(
      (link) =>
        link.querySelector(".vuuPortalNav-label")?.textContent === label,
    );

  test("renders PortalNav (no header) with the trader IA, brand and footer", async () => {
    const nav = await renderApp();
    const shell = nav.parentElement as HTMLElement;
    expect(shell.classList).toContain("vuuPortalShell-noHeader");
    expect(document.querySelector(".vuuPortalHeader")).toBeNull();
    expect(nav.dataset.displayMode).toBe("icons-and-text");
    expect(nav.classList).toContain("vuuPortalNav-sections-headings");

    const sections = [
      ...nav.querySelectorAll<HTMLElement>(".vuuPortalNav-section"),
    ].map((section) => [
      section.querySelector(".vuuPortalNav-sectionTitle")?.textContent,
      [...section.querySelectorAll(".vuuPortalNav-label")].map(
        (label) => label.textContent,
      ),
    ]);
    expect(sections).toEqual([
      ["Workspaces", ["Trader", "New workspace"]],
      ["Trading", ["Watchlist", "Orders", "Executions", "Price ladder"]],
      ["Market", ["Market depth", "Time & sales", "Chart", "Depth chart"]],
      ["Portfolio", ["Positions", "P&L", "Exposure", "Execution quality"]],
      ["Oversight", ["Desk overview"]],
    ]);
    expect(entry(nav, "Executions")?.getAttribute("href")).toBe(
      "/trading/executions",
    );
    expect(entry(nav, "Trader")?.getAttribute("href")).toBe(
      "/workspaces/trader",
    );
    // navIconUrl renders as a CSS mask (url('…')), one per entry
    expect(
      nav.querySelectorAll('.vuuPortalNav-icon [data-icon="custom"]'),
    ).toHaveLength(13);

    const brand = nav.querySelector(".vuuPortalNav-brand") as HTMLElement;
    const brandLink = brand.querySelector(".vuuPortalNav-brandLink");
    expect(brandLink?.getAttribute("href")).toBe("/");
    expect(brandLink?.getAttribute("aria-label")).toBe("Trader home");
    // the brand's target, `/`, is Trader's landing page
    expect(window.location.pathname).toBe("/");
    const home = document.querySelector(".vuuPortalLandingPage .traderHome");
    expect(home?.querySelector("h1")?.textContent).toBe("Trader");
    expect(home?.querySelector("a")?.getAttribute("href")).toBe(
      "/workspaces/trader",
    );
    expect(brand.querySelector(".traderNavBrand-name")?.textContent).toBe(
      "Trader",
    );
    expect(brand.querySelector(".traderNavBrand-env")?.textContent).toBe("UAT");
    expect(
      brand
        .querySelector(".vuuNotificationsIndicator")
        ?.getAttribute("data-scope"),
    ).toBe("unclaimed");

    const footer = nav.querySelector(".vuuPortalNav-footer") as HTMLElement;
    expect(footer.querySelector(".vuuPortalConnectionStatus")).not.toBeNull();
    expect(footer.querySelector(".vuuPortalNavUserMenu")).not.toBeNull();
    expect(footer.textContent).toContain("ACC-US-01");
  });

  test("Workspaces › Trader opens the Trader system workspace", async () => {
    const nav = await renderApp();
    await act(async () => entry(nav, "Trader")?.click());
    await wait(300);
    expect(window.location.pathname).toBe("/workspaces/trader");
    const header = document.querySelector<HTMLElement>(
      ".vuuPortalWorkspaceHeader",
    );
    expect(header?.dataset.workspaceId).toBe("trader");
    expect(
      header?.querySelector(".vuuPortalWorkspaceHeader-title")?.textContent,
    ).toBe("Trader");
    expect(
      [...document.querySelectorAll(".vuuGridLayoutItemHeader-title")].map(
        (title) => title.textContent,
      ),
    ).toEqual(["Instruments", "Ticket", "Ladder", "Tape"]);
    expect(
      [...document.querySelectorAll('[role="tab"]')].map(
        (tab) => tab.textContent,
      ),
    ).toEqual([
      "Orders",
      "Fills",
      "Positions",
      "Chart",
      "Depth",
      "Depth chart",
    ]);
  });

  test("Add panel opens the Panels palette, grouped by paletteGroup", async () => {
    const nav = await renderApp();
    await act(async () => entry(nav, "Trader")?.click());
    await wait(300);
    const addPanel = [
      ...document.querySelectorAll<HTMLButtonElement>(
        ".vuuPortalWorkspaceHeader button",
      ),
    ].find((button) => button.textContent?.includes("Add panel"));
    if (!addPanel) throw Error("no Add panel button");
    await act(async () => addPanel.click());
    await wait(300);
    const palette = document.querySelector(".vuuPanelsPalette");
    if (!palette) throw Error("Panels palette not open");
    // Modules and Recent only: no raw Tables tab
    expect(
      [...palette.querySelectorAll(".vuuPanelsPalette-tab")].map(
        (tab) => tab.textContent,
      ),
    ).toEqual(["Modules", "Recent"]);
    const groups = [...palette.querySelectorAll(".vuuPanelsPalette-group")].map(
      (group) => ({
        label: group.querySelector(".vuuPanelsPalette-groupHeader")
          ?.textContent,
        rows: [...group.querySelectorAll(".vuuPanelsPalette-label")].map(
          (label) => label.textContent,
        ),
      }),
    );
    expect(groups).toEqual([
      {
        label: "Trading",
        rows: [
          "Watchlist",
          "Orders",
          "Executions",
          "Price ladder",
          "Order ticket",
        ],
      },
      {
        label: "Market",
        rows: ["Market depth", "Time & sales", "Chart", "Depth chart"],
      },
      {
        label: "Portfolio",
        rows: ["Positions", "P&L", "Exposure", "Execution quality"],
      },
    ]);
  });

  test("a new workspace shows Trader's empty content, which opens the palette", async () => {
    const nav = await renderApp();
    await act(async () => entry(nav, "New workspace")?.click());
    await wait(300);
    const zone = document.querySelector(".vuuWorkspaceDropZone");
    if (!zone) throw Error("no empty workspace drop zone");
    expect(zone.textContent).toContain("Drag a module from the Panels palette");
    expect(zone.textContent).not.toContain("tables");
    const open = zone.querySelector<HTMLButtonElement>(
      ".traderEmptyWorkspace-open",
    );
    if (!open) throw Error("no Open Panels palette button");
    // + New workspace may open the palette itself: close it first
    for (const close of document.querySelectorAll<HTMLButtonElement>(
      ".vuuContextPanel [aria-label^='Close']",
    ))
      await act(async () => close.click());
    await wait(300);
    await act(async () => open.click());
    await wait(300);
    expect(document.querySelector(".vuuPanelsPalette")).not.toBeNull();
  });

  test("badges show working orders and P&L, and tick", async () => {
    const nav = await renderApp();
    const count = () =>
      entry(nav, "Orders")?.querySelector(".vuuPortalNav-count")?.textContent;
    const before = Number(count() ?? 0);
    const ric = td.sim.books[0].ric;
    const prices = td.exchange.getTable("prices");
    const bid = prices.findByKey(ric)?.[prices.map.bid] as number;
    await act(async () => {
      const created = td.rpc("createOrder", {
        account: "ACC-US-01",
        ric,
        side: "BUY",
        ordType: "LIMIT",
        quantity: 100,
        price: Math.floor(bid * 0.95),
      });
      expect(created).toMatchObject({ type: "SUCCESS_RESULT" });
      td.advance(100);
    });
    await wait(300);
    expect(Number(count())).toBe(before + 1);

    const pnl = entry(nav, "Positions")?.querySelector(".traderNavPnl");
    expect(pnl?.className).toMatch(/traderNavPnl-(up|down|flat)/);
  });

  test("rail mode: logo expands the nav; footer uses the rail variant", async () => {
    const nav = await renderApp();
    const collapse = nav.querySelector<HTMLButtonElement>(
      ".vuuPortalNav-headerButton",
    );
    await act(async () => collapse?.click());
    expect(nav.dataset.displayMode).toBe("icons");
    expect(nav.querySelector(".traderNavBrand-name")).toBeNull();
    expect(
      nav.querySelector(".vuuPortalNav-brand .vuuNotificationsIndicator"),
    ).not.toBeNull();
    expect(
      nav.querySelector(".vuuPortalConnectionStatus")?.className,
    ).toContain("rail");
    await act(async () =>
      nav
        .querySelector<HTMLButtonElement>(".traderNavBrand-logoButton")
        ?.click(),
    );
    expect(nav.dataset.displayMode).toBe("icons-and-text");
  });

  test("the user menu picks any of the four display modes", async () => {
    const nav = await renderApp();
    const pick = async (label: string) => {
      await act(async () =>
        nav
          .querySelector<HTMLButtonElement>(".vuuPortalNavUserMenu-trigger")
          ?.click(),
      );
      const items = [
        ...document.querySelectorAll<HTMLButtonElement>(
          ".traderNavDisplayMode",
        ),
      ];
      const labelOf = (item: HTMLElement) =>
        item.querySelector(".vuuPortalNavUserMenu-itemLabel")?.textContent;
      expect(items.map(labelOf)).toEqual([
        "Icons and text",
        "Text only",
        "Icons only",
        "Hidden",
      ]);
      const current = items.find((item) => item.hasAttribute("aria-current"));
      await act(async () =>
        items.find((item) => labelOf(item) === label)?.click(),
      );
      return current && labelOf(current);
    };
    expect(await pick("Text only")).toBe("Icons and text");
    expect(nav.dataset.displayMode).toBe("text");
    expect(await pick("Icons only")).toBe("Text only");
    expect(nav.dataset.displayMode).toBe("icons");
    expect(await pick("Hidden")).toBe("Icons only");
    expect(nav.dataset.displayMode).toBe("minimized");
  });
});
