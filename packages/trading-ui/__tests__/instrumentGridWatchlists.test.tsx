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
import { InstrumentGrid, TradingDataProvider } from "../src";
import type { UserSettingsStorage } from "../src/utils/userSettingsStorage";

const gridId = "grid-watchlists-test";

setCurrentUser({ name: "admin", authorizations: [] });
const td = createTradingTestData({
  seed: 7,
  exchange: { activeInstruments: 3 },
  oms: { flowRate: 0 },
  manualClock: true,
});
const localServer = createTradingLocalServer(td, "grid-watchlists-test");

afterEach(cleanup);
afterAll(() => td.dispose());

const memoryStorage = (initial: Record<string, string>) => {
  const items = new Map(Object.entries(initial));
  const storage: UserSettingsStorage = {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
    removeItem: (key) => {
      items.delete(key);
    },
  };
  return { items, storage };
};

const lists = (items: Map<string, string>) =>
  JSON.parse(items.get("trading.watchlists") ?? "{}").lists as {
    name: string;
    rics: string[];
  }[];

const renderGrid = (more: Record<string, string> = {}) => {
  const { items, storage } = memoryStorage({
    "trading.watchlists": JSON.stringify({
      lists: [{ id: "empty", name: "Empty", rics: [] }],
    }),
    ...more,
  });
  render(
    <TradingDataProvider localServer={localServer} mode="local">
      <InstrumentGrid id={gridId} watchlistStorage={storage} />
    </TradingDataProvider>,
  );
  return items;
};

const openScopeMenu = async (label: string) => {
  fireEvent.click(
    await screen.findByRole("button", { name: `Instruments: ${label}` }),
  );
};

describe("InstrumentGrid watchlists", () => {
  test("an empty list offers Add instruments, which edits it", async () => {
    const items = renderGrid();
    await openScopeMenu("All instruments");
    fireEvent.click(
      await screen.findByRole("menuitemradio", { name: /Empty/ }),
    );
    const add = await screen.findByRole("button", { name: "Add instruments…" });
    expect(screen.getByText("Empty is empty")).toBeTruthy();

    act(() => add.click());
    await screen.findByText("Edit Empty");
    const option = await waitFor(() => {
      const first = screen
        .getAllByRole("option")
        .find((o) => o.classList.contains("tradingWatchlistDialog-row"));
      if (!first) throw Error("no instruments yet");
      return first;
    });
    act(() => option.click());
    act(() => screen.getByRole("button", { name: "Save" }).click());

    await waitFor(() =>
      expect(screen.queryByText("Empty is empty")).toBeNull(),
    );
    expect(lists(items)[0].rics).toHaveLength(1);
  });

  test("Rename names the list in a Salt prompt", async () => {
    const items = renderGrid();
    await openScopeMenu("All instruments");
    fireEvent.click(
      await screen.findByRole("menuitemradio", { name: /Empty/ }),
    );
    await openScopeMenu("Empty");
    fireEvent.click(await screen.findByRole("menuitem", { name: /Rename/ }));
    const input = await screen.findByLabelText("Name");
    fireEvent.change(input, { target: { value: "Energy" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findByRole("button", { name: "Instruments: Energy" });
    expect(lists(items)[0].name).toBe("Energy");
  });

  test("deleting a watchlist keeps its column sets as shared, or deletes them", async () => {
    for (const keep of [true, false]) {
      const items = renderGrid({
        [`trading.instrumentGrid.columnSets:${gridId}`]: JSON.stringify({
          activeColumnSet: "Mine",
          columnSets: [
            { name: "Mine", columns: ["ric", "bid"], savedColumns: ["ric"] },
            { name: "Theirs", columns: ["ric"], savedColumns: ["ric"] },
          ],
        }),
        [`trading.instrumentGrid.columnSetMeta:${gridId}`]: JSON.stringify({
          Theirs: { scope: "empty" },
        }),
      });
      await screen.findByRole("tab", { name: "Mine" });
      expect(screen.queryByRole("tab", { name: "Theirs" })).toBeNull();
      await openScopeMenu("All instruments");
      fireEvent.click(
        await screen.findByRole("menuitemradio", { name: /Empty/ }),
      );
      await screen.findByRole("tab", { name: "Theirs" });
      await openScopeMenu("Empty");
      fireEvent.click(
        await screen.findByRole("menuitem", { name: /Delete Empty/ }),
      );
      const checkbox = await screen.findByRole("checkbox", {
        name: /Keep its column set \(Theirs\)/,
      });
      if (!keep) fireEvent.click(checkbox);
      act(() => screen.getByRole("button", { name: "Delete" }).click());
      await screen.findByRole("button", {
        name: "Instruments: All instruments",
      });
      if (keep) {
        await screen.findByRole("tab", { name: "Theirs" });
        expect(
          JSON.parse(
            items.get(`trading.instrumentGrid.columnSetMeta:${gridId}`) ?? "",
          ).Theirs,
        ).toEqual({});
      } else {
        await waitFor(() =>
          expect(screen.queryByRole("tab", { name: "Theirs" })).toBeNull(),
        );
        expect(
          JSON.parse(
            items.get(`trading.instrumentGrid.columnSets:${gridId}`) ?? "",
          ).columnSets.map(({ name }: { name: string }) => name),
        ).toEqual(["Mine"]);
      }
      cleanup();
    }
  });
});
