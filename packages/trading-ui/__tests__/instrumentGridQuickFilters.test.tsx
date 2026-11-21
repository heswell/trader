import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  createTradingTestData,
  setCurrentUser,
} from "@heswell/trading-test-data";
import { createTradingLocalServer } from "@heswell/trading-test-data/react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { InstrumentGrid, TradingDataProvider } from "../src";
import type { UserSettingsStorage } from "../src/utils/userSettingsStorage";

const gridId = "quick-filters-test";

setCurrentUser({ name: "admin", authorizations: [] });
const td = createTradingTestData({
  seed: 7,
  exchange: { activeInstruments: 3 },
  oms: { flowRate: 0 },
  manualClock: true,
});
const localServer = createTradingLocalServer(td, "quick-filters-test");

afterEach(cleanup);
afterAll(() => td.dispose());

describe("InstrumentGrid quick filters", () => {
  test("a quick filter suggests values from the grid's table", async () => {
    const { container } = render(
      <TradingDataProvider localServer={localServer} mode="local">
        <InstrumentGrid id={gridId} />
      </TradingDataProvider>,
    );
    const input = await waitFor(() => {
      const el = container.querySelector<HTMLInputElement>(
        '.vuuQuickFilters-filter[data-field="exchange"] input',
      );
      if (!el) throw Error("no exchange quick filter");
      return el;
    });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "X" } });
    await waitFor(
      () => {
        const options = screen
          .getAllByRole("option")
          .map((o) => o.textContent ?? "");
        expect(options).toContain("XLON");
      },
      { timeout: 3000 },
    );
  });

  test("each column set has its own quick filter fields (Alt+n switches)", async () => {
    const items = new Map<string, string>();
    const storage: UserSettingsStorage = {
      getItem: (key) => items.get(key) ?? null,
      removeItem: (key) => {
        items.delete(key);
      },
      setItem: (key, value) => {
        items.set(key, value);
      },
    };
    const { container } = render(
      <TradingDataProvider localServer={localServer} mode="local">
        <InstrumentGrid id={gridId} watchlistStorage={storage} />
      </TradingDataProvider>,
    );
    const fields = () =>
      [
        ...container.querySelectorAll<HTMLElement>(".vuuQuickFilters-filter"),
      ].map((el) => el.dataset.field);
    await waitFor(() =>
      expect(fields()).toEqual(["exchange", "sector", "instrumentType"]),
    );
    const grid = container.querySelector(".tradingInstrumentGrid") as Element;
    fireEvent.keyDown(grid, { altKey: true, code: "Digit2", key: "2" });
    await waitFor(() =>
      expect(fields()).toEqual([
        "sector",
        "marketCapUsd",
        "pe",
        "dividendYield",
      ]),
    );
    // the default sets' quick filters are saved with the sets
    const metaKey = [...items.keys()].find((k) => k.includes("columnSetMeta"));
    expect(JSON.parse(items.get(metaKey as string) ?? "{}")).toEqual({
      Screening: {
        quickFilterColumns: ["sector", "marketCapUsd", "pe", "dividendYield"],
      },
      Watchlist: {
        quickFilterColumns: ["exchange", "sector", "instrumentType"],
      },
    });
    fireEvent.keyDown(grid, { altKey: true, code: "Digit1", key: "1" });
    await waitFor(() =>
      expect(fields()).toEqual(["exchange", "sector", "instrumentType"]),
    );
  });

  test("a value on a field the set doesn't show is Also applied, and clears", async () => {
    const { container } = render(
      <TradingDataProvider localServer={localServer} mode="local">
        <InstrumentGrid id={gridId} />
      </TradingDataProvider>,
    );
    const exchangeInput = () =>
      container.querySelector<HTMLInputElement>(
        '.vuuQuickFilters-filter[data-field="exchange"] input',
      );
    const input = await waitFor(() => {
      const el = exchangeInput();
      if (!el) throw Error("no exchange quick filter");
      return el;
    });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "X" } });
    const option = await waitFor(
      () => screen.getByRole("option", { name: "XLON" }),
      { timeout: 3000 },
    );
    fireEvent.click(option);
    const grid = container.querySelector(".tradingInstrumentGrid") as Element;
    // Screening doesn't show exchange: its value is Also applied
    fireEvent.keyDown(grid, { altKey: true, code: "Digit2", key: "2" });
    const clear = await waitFor(() =>
      screen.getByRole("button", { name: "Clear Exchange: XLON" }),
    );
    fireEvent.click(clear);
    await waitFor(() =>
      expect(
        container.querySelector(".tradingInstrumentGrid-alsoApplied"),
      ).toBeNull(),
    );
    // back to Watchlist: the cleared value stays clear
    fireEvent.keyDown(grid, { altKey: true, code: "Digit1", key: "1" });
    await waitFor(() => expect(exchangeInput()?.value).toBe(""));
  });
});
