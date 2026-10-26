import { describe, expect, test } from "bun:test";
import { TRADING_FEATURES } from "../../features/trading/src/catalog";
import { validateNamedWorkspaceDefinitionV1 } from "@vuu-ui/core";
import { createPortalComponentRegistries } from "@vuu-ui/core/portal";
import { decodeGridLayoutDocument } from "@vuu-ui/grid-layout";
import {
  SYSTEM_WORKSPACES,
  TRADER_WORKSPACE,
  TRADER_WORKSPACE_ID,
} from "../src/workspaces/traderWorkspace";

const { layout } = TRADER_WORKSPACE.snapshot;

describe("Trader system workspace", () => {
  test("is the only system workspace, served at /workspaces/trader", () => {
    expect(SYSTEM_WORKSPACES).toEqual([TRADER_WORKSPACE]);
    expect(TRADER_WORKSPACE.id).toBe(TRADER_WORKSPACE_ID);
    expect(TRADER_WORKSPACE_ID).toBe("trader");
  });

  test("is a valid named workspace definition", () => {
    expect(validateNamedWorkspaceDefinitionV1(TRADER_WORKSPACE)).toEqual(
      TRADER_WORKSPACE,
    );
  });

  test("decodes as a v2 GridLayoutDocument with the portal codecs", () => {
    const { settingsCodecs } = createPortalComponentRegistries();
    const result = decodeGridLayoutDocument(layout, settingsCodecs);
    if (!result.ok) throw new Error(result.error.message);
    expect(layout.kind).toBe("grid-layout");
    expect(layout.version).toBe(2);
  });

  test("every panel is a palette module of the trading catalog", () => {
    const palette = new Map(
      TRADING_FEATURES.filter((f) => f.workspace).map((f) => [f.name, f]),
    );
    for (const component of layout.components) {
      expect(component.type).toBe("portal-module");
      const { moduleId } = component.settings as { moduleId: string };
      expect(palette.has(moduleId)).toBe(true);
    }
  });

  test("keeps the default layout: stacked blotters and market panels", () => {
    expect(layout.layout.columns).toHaveLength(3);
    expect(
      layout.layout.stacks?.map(({ itemIds, selectedItemId }) => [
        itemIds,
        selectedItemId,
      ]),
    ).toEqual([
      [["trader-orders", "trader-fills", "trader-positions"], "trader-orders"],
      [["trader-chart", "trader-depth", "trader-depth-chart"], "trader-chart"],
    ]);
    const ladder = layout.components.find((c) => c.id === "trader-ladder");
    expect(ladder?.settings).toEqual({
      moduleId: "TradingLadder",
      props: { showInstrumentPicker: true },
    });
  });
});
