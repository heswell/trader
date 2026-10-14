import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  createTradingTestData,
  setCurrentUser,
} from "@heswell/trading-test-data";
import { createTradingLocalServer } from "@heswell/trading-test-data/react";
import { cleanup, render, screen } from "@testing-library/react";
import { POSITIONS_GROUP_BY, PositionsView, TradingDataProvider } from "../src";

setCurrentUser({ name: "admin", authorizations: [] });
const testData = createTradingTestData({
  seed: 3,
  exchange: { activeInstruments: 3 },
  oms: { flowRate: 0 },
  manualClock: true,
});
const localServer = createTradingLocalServer(testData, "positions-view");

afterEach(cleanup);
afterAll(() => testData.dispose());

describe("PositionsView", () => {
  test("groups by currency then sector by default", () => {
    render(
      <TradingDataProvider mode="local" localServer={localServer}>
        <PositionsView />
      </TradingDataProvider>,
    );
    const select = screen.getByLabelText("Group by") as HTMLSelectElement;
    expect(select.value).toBe("sector");
    expect(
      Array.from(select.options).map((o) => [o.value, o.textContent]),
    ).toContainEqual(["sector", "Currency / sector"]);
    expect(POSITIONS_GROUP_BY.sector).toEqual(["currency", "sector"]);
  });

  test("every grouping groups by currency first", () => {
    for (const [grouping, groupBy] of Object.entries(POSITIONS_GROUP_BY)) {
      if (grouping !== "none") expect(groupBy[0]).toBe("currency");
    }
    expect(POSITIONS_GROUP_BY.none).toEqual([]);
  });
});
