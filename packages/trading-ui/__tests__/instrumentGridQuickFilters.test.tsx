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
});
