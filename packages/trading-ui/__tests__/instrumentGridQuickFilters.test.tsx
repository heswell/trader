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
    const metaKey = [...items.keys()].find((k) => k.includes("columnSetMeta"));
    expect(metaKey).toBeUndefined(); // the defaults are not saved until changed
    fireEvent.keyDown(grid, { altKey: true, code: "Digit1", key: "1" });
    await waitFor(() =>
      expect(fields()).toEqual(["exchange", "sector", "instrumentType"]),
    );
  });
});
