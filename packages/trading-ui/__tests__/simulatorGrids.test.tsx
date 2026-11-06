import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  createTradingTestData,
  setCurrentUser,
} from "@heswell/trading-test-data";
import { createTradingLocalServer } from "@heswell/trading-test-data/react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import {
  BOTS_GROUP_BY,
  BotDetail,
  BotFillsTape,
  SIM_FLOW_GROUPS,
  SimInstrumentChart,
  BotsGrid,
  SIM_BOOKS_SORT,
  SimBooksGrid,
  TradingDataProvider,
} from "../src";

setCurrentUser({ name: "admin", authorizations: [] });
const testData = createTradingTestData({
  seed: 5,
  exchange: { activeInstruments: 2 },
  oms: { flowRate: 0 },
  manualClock: true,
});
const localServer = createTradingLocalServer(testData, "simulator-grids");

afterEach(cleanup);
afterAll(() => testData.dispose());

const wrap = (children: React.ReactNode) => (
  <TradingDataProvider mode="local" localServer={localServer}>
    {children}
  </TradingDataProvider>
);

describe("simulator grids", () => {
  test("SimBooksGrid offers its sorts", () => {
    render(wrap(<SimBooksGrid defaultSort="gap" />));
    const select = screen.getByLabelText("Sort by") as HTMLSelectElement;
    expect(select.value).toBe("gap");
    expect(Array.from(select.options).map((o) => o.value)).toEqual(
      Object.keys(SIM_BOOKS_SORT),
    );
  });

  test("BotsGrid groups by kind by default", () => {
    render(wrap(<BotsGrid />));
    const select = screen.getByLabelText("Group by") as HTMLSelectElement;
    expect(select.value).toBe("kind");
    expect(Array.from(select.options).map((o) => o.value)).toEqual(
      Object.keys(BOTS_GROUP_BY),
    );
  });

  test("BotDetail shows a bot's stats and parameters", async () => {
    const bot = testData.sim.getBots()[0];
    if (!bot) throw Error("no bots");
    render(wrap(<BotDetail botId={bot.id} />));
    await waitFor(() =>
      expect(screen.getByText(bot.id, { exact: false })).toBeTruthy(),
    );
    const params = screen.getByTestId("trading-bot-params");
    await waitFor(() =>
      expect(params.textContent).toContain("halfSpreadTicks"),
    );
  });

  test("BotDetail without a bot", () => {
    render(wrap(<BotDetail botId={undefined} />));
    expect(screen.getByText("Select a bot")).toBeTruthy();
  });

  test("BotFillsTape names the followed instrument or the party", () => {
    render(wrap(<BotFillsTape ric="VOD.L" />));
    expect(screen.getByText("VOD.L attributed fills")).toBeTruthy();
    cleanup();
    render(wrap(<BotFillsTape party="VOD.L/MM1" />));
    expect(screen.getByText("Fills of VOD.L/MM1")).toBeTruthy();
  });

  test("SimInstrumentChart waits for an instrument; flow groups cover every owner", () => {
    render(wrap(<SimInstrumentChart />));
    expect(screen.getByText("Select an instrument")).toBeTruthy();
    expect(SIM_FLOW_GROUPS.map((g) => g.column)).toEqual([
      "mmNet",
      "takerNet",
      "omsNet",
      "botNet",
    ]);
  });
});
