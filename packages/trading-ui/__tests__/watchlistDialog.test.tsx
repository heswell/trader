import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
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
import { TradingDataProvider } from "../src";
import { updateWatchlist } from "../src/components/InstrumentGrid/watchlists";
import {
  addRics,
  facetSummary,
  isNarrowed,
  pickerFilter,
  toggleRic,
  WatchlistDialog,
} from "../src/components/WatchlistDialog";

setCurrentUser({ name: "admin", authorizations: [] });
const testData = createTradingTestData({
  seed: 5,
  exchange: { activeInstruments: 3 },
  oms: { flowRate: 0 },
  manualClock: true,
});
const localServer = createTradingLocalServer(testData, "watchlist-dialog");

afterEach(() => cleanup());
afterAll(() => testData.dispose());

describe("watchlist picker helpers", () => {
  test("pickerFilter ANDs facets with the text search", () => {
    expect(pickerFilter("", {})).toBe("");
    expect(pickerFilter("", { sector: ["Energy"] })).toBe('sector = "Energy"');
    expect(
      pickerFilter("", { sector: ["Energy", "Banks"], instrumentType: [] }),
    ).toBe('sector in ["Energy","Banks"]');
    const both = pickerFilter("bp", { instrumentType: ["EQUITY"] });
    expect(both.startsWith('instrumentType = "EQUITY" and (')).toBe(true);
    expect(both).toContain("ric");
  });

  test("isNarrowed and facetSummary", () => {
    expect(isNarrowed(" ", { sector: [] })).toBe(false);
    expect(isNarrowed("", { currency: ["GBP"] })).toBe(true);
    expect(facetSummary("sector", [])).toBe("Any");
    expect(facetSummary("instrumentType", ["FUTURE"])).toBe("Future");
    expect(facetSummary("sector", ["Energy", "Banks", "Mining"])).toBe(
      "Energy +2",
    );
  });

  test("addRics keeps order and skips duplicates; toggleRic flips", () => {
    expect(addRics(["A"], ["B", "A", "C", "B"])).toEqual(["A", "B", "C"]);
    expect(toggleRic(["A", "B"], "A")).toEqual(["B"]);
    expect(toggleRic(["A"], "B")).toEqual(["A", "B"]);
  });

  test("updateWatchlist replaces name and rics", () => {
    const state = { lists: [{ id: "a", name: "A", rics: ["X"] }] };
    expect(
      updateWatchlist(state, "a", { name: " B ", rics: ["Y", "Y", "Z"] }),
    ).toEqual({ lists: [{ id: "a", name: "B", rics: ["Y", "Z"] }] });
    expect(updateWatchlist(state, "a", { name: "" }).lists[0].name).toBe("A");
  });
});

const renderDialog = (
  props: Partial<Parameters<typeof WatchlistDialog>[0]>,
) => {
  const onSave = mock(() => undefined);
  const onClose = mock(() => undefined);
  render(
    <TradingDataProvider localServer={localServer} mode="local">
      <WatchlistDialog
        lists={[{ id: "energy", name: "Energy", rics: [] }]}
        onClose={onClose}
        onSave={onSave}
        {...props}
      />
    </TradingDataProvider>,
  );
  return { onClose, onSave };
};

const options = () => screen.queryAllByRole("option");

describe("WatchlistDialog", () => {
  test("search, Enter to pick, Ctrl+Enter to create", async () => {
    const { onSave, onClose } = renderDialog({});
    await waitFor(() => expect(options().length).toBeGreaterThan(1));
    const create = screen.getByRole("button", { name: "Create watchlist" });
    expect(create.hasAttribute("disabled")).toBe(true);

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "energy" },
    });
    expect(screen.getByText("A watchlist called energy already exists")).toBe(
      screen.getByText("A watchlist called energy already exists"),
    );
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Mine" },
    });

    const search = screen.getByRole("combobox", {
      name: "Search by RIC or name",
    });
    const first = options()[0];
    const firstRic = first.querySelector(".tradingWatchlistDialog-ric")
      ?.textContent as string;
    fireEvent.keyDown(search, { key: "Enter" });
    await waitFor(() =>
      expect(options()[0].getAttribute("aria-selected")).toBe("true"),
    );
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "Enter" });
    const secondRic = options()[1].querySelector(".tradingWatchlistDialog-ric")
      ?.textContent as string;

    expect(screen.getByRole("button", { name: "Create with 2" })).toBeTruthy();
    fireEvent.keyDown(search, { key: "Enter", ctrlKey: true });
    expect(onSave).toHaveBeenCalledWith({
      name: "Mine",
      rics: [firstRic, secondRic],
    });
    expect(onClose).toHaveBeenCalled();
  });

  test("a search offers Add matches, which picks every match", async () => {
    const { onSave } = renderDialog({ initialRics: [] });
    await waitFor(() => expect(options().length).toBeGreaterThan(1));
    const ric = options()[0].querySelector(".tradingWatchlistDialog-ric")
      ?.textContent as string;
    expect(screen.queryByRole("button", { name: /^Add / })).toBeNull();

    fireEvent.change(screen.getByLabelText("Search by RIC or name"), {
      target: { value: ric },
    });
    const add = await screen.findByRole("button", {
      name: /^Add (all )?\d+ match/,
    });
    act(() => add.click());
    await screen.findByText("All matches are in the list");

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Picks" },
    });
    act(() => screen.getByRole("button", { name: /^Create with/ }).click());
    const saved = (onSave.mock.calls[0] as unknown as [{ rics: string[] }])[0];
    expect(saved.rics).toContain(ric);
  });

  test("edit shows the list's name and rics, and saves changes", async () => {
    const { onSave } = renderDialog({
      editing: { id: "energy", name: "Energy", rics: [] },
    });
    await waitFor(() => expect(options().length).toBeGreaterThan(0));
    expect(screen.getByText("Edit Energy")).toBeTruthy();
    // Its own name is not a duplicate.
    const save = screen.getByRole("button", { name: "Save" });
    expect(save.hasAttribute("disabled")).toBe(false);
    act(() => options()[0].click());
    act(() => save.click());
    expect(onSave).toHaveBeenCalledTimes(1);
  });
});
