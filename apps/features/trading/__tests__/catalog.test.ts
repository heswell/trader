import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { modulesYaml } from "../../../../scripts/stack/modules";
import { TRADING_FEATURES } from "../src/catalog";

interface YamlModule {
  id: number;
  parentModuleId: number;
  name: string;
  location?: string;
  path?: string;
  navIconUrl: string;
  accessRole: string;
  navOrder?: number;
  navBadge?: string;
  notificationTopics?: string[];
  workspace?: unknown;
}

const parse = (yaml: string) =>
  (Bun.YAML.parse(yaml) as { modules: YamlModule[] }).modules;

const topLevel = TRADING_FEATURES.filter((f) => !f.parent);

describe("trading catalog information architecture", () => {
  test("nav entries, in navOrder", () => {
    expect(
      topLevel
        .filter((f) => f.location)
        .sort((a, b) => (a.navOrder ?? 0) - (b.navOrder ?? 0))
        .map((f) => [f.id, f.location, f.path, f.navOrder]),
    ).toEqual([
      [110, "/Trading/Watchlist", "/trading/watchlist", 100],
      [114, "/Trading/Orders", "/trading/orders", 110],
      [115, "/Trading/Executions", "/trading/executions", 120],
      [112, "/Trading/Price ladder", "/trading/price-ladder", 130],
      [111, "/Market/Market depth", "/market/depth", 200],
      [117, "/Market/Time & sales", "/market/time-and-sales", 210],
      [118, "/Market/Chart", "/market/chart", 220],
      [119, "/Market/Depth chart", "/market/depth-chart", 230],
      [116, "/Portfolio/Positions", "/portfolio/positions", 300],
      [121, "/Portfolio/P&L", "/portfolio/pnl", 310],
      [122, "/Portfolio/Exposure", "/portfolio/exposure", 320],
      [
        123,
        "/Portfolio/Execution quality",
        "/portfolio/execution-quality",
        330,
      ],
      [120, "/Oversight/Desk overview", "/oversight/desk", 400],
    ]);
  });

  test("the order ticket is palette-only: no nav location or route", () => {
    const ticket = TRADING_FEATURES.find((f) => f.id === 124);
    expect(ticket?.location).toBeUndefined();
    expect(ticket?.path).toBeUndefined();
    expect(ticket?.navOrder).toBeUndefined();
    expect(ticket?.workspace?.paletteGroup).toBe("Trading");
    expect(topLevel.filter((f) => !f.location).map((f) => f.id)).toEqual([124]);
  });

  test("badges, topics and roles", () => {
    const byId = new Map(TRADING_FEATURES.map((f) => [f.id, f]));
    expect(byId.get(114)?.navBadge).toBe("orders.working");
    expect(byId.get(116)?.navBadge).toBe("positions.dayPnl");
    expect(TRADING_FEATURES.filter((f) => f.navBadge).map((f) => f.id)).toEqual(
      [114, 116],
    );
    expect(byId.get(124)?.notificationTopics).toEqual(["orders"]);
    expect(byId.get(116)?.notificationTopics).toEqual(["positions", "risk"]);
    expect(byId.get(120)?.notificationTopics).toEqual(["risk", "orders"]);
    expect(byId.get(112)?.accessRole).toBe("trading-execute-access");
    expect(byId.get(124)?.accessRole).toBe("trading-execute-access");
    expect(byId.get(120)?.accessRole).toBe("trading-supervisor-access");
  });

  test("ids and names are unique; the workspace modules (100-102) are retired", () => {
    const ids = TRADING_FEATURES.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(TRADING_FEATURES.map((f) => f.name)).size).toBe(ids.length);
    expect(new Set(TRADING_FEATURES.map((f) => f.mfScope)).size).toBe(
      ids.length,
    );
    // 113 was an earlier standalone ticket; 100-102 the vuu-layout Trader
    // workspace and its child modules (now a portal system workspace)
    for (const retired of [100, 101, 102, 113])
      expect(ids).not.toContain(retired);
    expect(TRADING_FEATURES.filter((f) => f.parent)).toEqual([]);
    for (const f of topLevel) expect(f.navIcon).toBeDefined();
  });

  test("Panels palette: every feature but the desk overview, grouped by nav section", () => {
    const palette = TRADING_FEATURES.filter((f) => f.workspace);
    expect(
      TRADING_FEATURES.filter((f) => !f.workspace).map((f) => f.name),
    ).toEqual(["TradingSupervisor"]);
    for (const f of palette) {
      if (f.location)
        expect(f.location.split("/")[1]).toBe(f.workspace?.paletteGroup);
      const { cols = 0, rows = 0 } = f.workspace?.defaultSize ?? {};
      expect(cols).toBeGreaterThan(0);
      expect(rows).toBeGreaterThan(0);
    }
    const tall = palette
      .filter(
        ({ workspace: w }) =>
          (w?.defaultSize?.rows ?? 0) > (w?.defaultSize?.cols ?? 0),
      )
      .map((f) => f.key);
    expect(tall).toEqual(["ladder", "ticket", "depth", "tape"]);
  });
});

describe("default-modules.yaml generation", () => {
  test("the committed file is up to date", () => {
    const committed = readFileSync(
      resolve(import.meta.dir, "../../../portal-config/default-modules.yaml"),
      "utf8",
    );
    expect(committed).toBe(modulesYaml());
  });

  test("emits nav fields that parse as the portal expects", () => {
    const modules = parse(modulesYaml("http://features.test"));
    expect(modules).toHaveLength(TRADING_FEATURES.length);
    const orders = modules.find((m) => m.id === 114);
    expect(orders).toMatchObject({
      parentModuleId: 0,
      location: "/Trading/Orders",
      path: "/trading/orders",
      navOrder: 110,
      navBadge: "orders.working",
      notificationTopics: ["orders"],
    });
    const ticket = modules.find((m) => m.id === 124);
    expect(ticket).toMatchObject({
      parentModuleId: 0,
      workspace: { paletteGroup: "Trading", defaultSize: { cols: 1, rows: 2 } },
    });
    // palette-only: the fields are omitted, not written as ""
    expect(ticket && "location" in ticket).toBe(false);
    expect(ticket && "path" in ticket).toBe(false);
    expect(orders?.workspace).toEqual({
      paletteGroup: "Trading",
      defaultSize: { cols: 2, rows: 1 },
    });
    expect(modules.find((m) => m.id === 120)?.workspace).toBeUndefined();
    for (const m of modules.filter((m) => m.parentModuleId === 0)) {
      expect(m.navIconUrl).toStartWith("data:image/svg+xml");
      expect(m.navIconUrl).not.toContain("'");
    }
  });
});
