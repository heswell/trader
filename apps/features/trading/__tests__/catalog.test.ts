import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { modulesYaml } from "../../../../scripts/stack/modules";
import { TRADING_FEATURES } from "../src/catalog";

interface YamlModule {
  id: number;
  parentModuleId: number;
  name: string;
  location: string;
  path: string;
  navIconUrl: string;
  accessRole: string;
  navOrder?: number;
  navBadge?: string;
  notificationTopics?: string[];
}

const parse = (yaml: string) =>
  (Bun.YAML.parse(yaml) as { modules: YamlModule[] }).modules;

const topLevel = TRADING_FEATURES.filter((f) => !f.parent);

describe("trading catalog information architecture", () => {
  test("nav entries, in navOrder", () => {
    expect(
      [...topLevel]
        .sort((a, b) => (a.navOrder ?? 0) - (b.navOrder ?? 0))
        .map((f) => [f.id, f.location, f.path, f.navOrder]),
    ).toEqual([
      [100, "/Workspaces/Trader", "/workspaces/trader", 10],
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

  test("badges, topics and roles", () => {
    const byId = new Map(TRADING_FEATURES.map((f) => [f.id, f]));
    expect(byId.get(114)?.navBadge).toBe("orders.working");
    expect(byId.get(116)?.navBadge).toBe("positions.dayPnl");
    expect(TRADING_FEATURES.filter((f) => f.navBadge).map((f) => f.id)).toEqual(
      [114, 116],
    );
    expect(byId.get(100)?.notificationTopics).toEqual([
      "orders",
      "fills",
      "marketdata",
      "risk",
    ]);
    expect(byId.get(116)?.notificationTopics).toEqual(["positions", "risk"]);
    expect(byId.get(120)?.notificationTopics).toEqual(["risk", "orders"]);
    expect(byId.get(112)?.accessRole).toBe("trading-execute-access");
    expect(byId.get(120)?.accessRole).toBe("trading-supervisor-access");
  });

  test("ids and names are unique; the standalone ticket (113) is gone", () => {
    const ids = TRADING_FEATURES.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(TRADING_FEATURES.map((f) => f.name)).size).toBe(ids.length);
    expect(new Set(TRADING_FEATURES.map((f) => f.mfScope)).size).toBe(
      ids.length,
    );
    expect(ids).not.toContain(113);
    const children = TRADING_FEATURES.filter((f) => f.parent);
    expect(children.map((f) => f.id).sort()).toEqual([101, 102]);
    for (const child of children) {
      expect(child.location).toBeUndefined();
      expect(child.navOrder).toBeUndefined();
    }
    for (const f of topLevel) expect(f.navIcon).toBeDefined();
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
    const ticket = modules.find((m) => m.id === 101);
    expect(ticket).toMatchObject({ parentModuleId: 100, location: "" });
    expect(ticket?.navOrder).toBeUndefined();
    expect(ticket?.notificationTopics).toBeUndefined();
    for (const m of modules.filter((m) => m.parentModuleId === 0)) {
      expect(m.navIconUrl).toStartWith("data:image/svg+xml");
      expect(m.navIconUrl).not.toContain("'");
    }
  });
});
