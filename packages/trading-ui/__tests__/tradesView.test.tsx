import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  createTradingTestData,
  setCurrentUser,
} from "@heswell/trading-test-data";
import { createTradingLocalServer } from "@heswell/trading-test-data/react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { TradesView, TradingDataProvider, tradesViewTableConfig } from "../src";

setCurrentUser({ name: "admin", authorizations: [] });
const testData = createTradingTestData({
  seed: 3,
  exchange: { activeInstruments: 3, tradesSeed: 500 },
  oms: { flowRate: 0 },
  manualClock: true,
});
const localServer = createTradingLocalServer(testData, "trades-view");

afterEach(cleanup);
afterAll(() => testData.dispose());

const rowCount = () =>
  Number(
    screen.getByTestId("trades-row-count").textContent?.replace(/\D/g, ""),
  );

describe("TradesView", () => {
  test("shows every trade, then only the linked instrument's", async () => {
    render(
      <TradingDataProvider mode="local" localServer={localServer}>
        <TradesView />
      </TradingDataProvider>,
    );
    await waitFor(() => expect(rowCount()).toBe(500));
    expect(
      screen
        .getByRole("button", { name: /Export CSV/ })
        .hasAttribute("disabled"),
    ).toBe(false);
    // no linked instrument: the linked scope matches nothing
    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: "Linked" }));
    });
    await waitFor(() => expect(rowCount()).toBe(0));
    expect(
      screen.getByTestId("trading-trades-view").getAttribute("data-scope"),
    ).toBe("linked");
  });

  test("table config: time, ric, side, price, size, trade id, seq", () => {
    expect(tradesViewTableConfig.columns.map((c) => c.name)).toEqual([
      "timestamp",
      "ric",
      "aggressorSide",
      "price",
      "size",
      "tradeId",
      "seq",
    ]);
  });
});
