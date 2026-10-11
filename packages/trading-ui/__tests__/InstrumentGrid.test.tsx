import { describe, expect, test } from "bun:test";
import { act, renderHook, waitFor } from "@testing-library/react";
import {
  addToWatchlist,
  buildInstrumentGridFilter,
  createMemorySettingsStorage,
  createWatchlist,
  deleteWatchlist,
  instrumentGridColumns,
  parseWatchlists,
  quickFilterExpression,
  removeFromWatchlist,
  renameWatchlist,
  useWatchlists,
  WATCHLISTS_SETTINGS_KEY,
} from "../src";

describe("watchlist state", () => {
  test("create, add, remove, rename, delete", () => {
    let { state, id } = createWatchlist({ lists: [] }, "My List", ["A"]);
    expect(id).toBe("my-list");
    state = addToWatchlist(state, id, "B");
    state = addToWatchlist(state, id, "B");
    expect(state.lists[0].rics).toEqual(["A", "B"]);
    state = removeFromWatchlist(state, id, "A");
    expect(state.lists[0].rics).toEqual(["B"]);
    state = renameWatchlist(state, id, "Renamed");
    expect(state.lists[0].name).toBe("Renamed");
    expect(createWatchlist(state, "My List").id).toBe("my-list-2");
    expect(deleteWatchlist(state, id).lists).toEqual([]);
  });

  test("parse is defensive", () => {
    expect(parseWatchlists("nonsense").lists).toEqual([]);
    expect(parseWatchlists('{"lists":[{"id":1}]}').lists).toEqual([]);
    expect(
      parseWatchlists('{"lists":[{"id":"a","name":"A","rics":["X","X",3]}]}')
        .lists[0].rics,
    ).toEqual(["X"]);
  });

  test("useWatchlists persists through the storage", async () => {
    const storage = createMemorySettingsStorage({
      [WATCHLISTS_SETTINGS_KEY]: JSON.stringify({
        lists: [{ id: "a", name: "A", rics: ["X"] }],
      }),
    });
    const { result } = renderHook(() => useWatchlists(storage));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.lists).toHaveLength(1);
    act(() => {
      result.current.add("a", "Y");
    });
    expect(
      JSON.parse(storage.getItem(WATCHLISTS_SETTINGS_KEY) as string).lists[0]
        .rics,
    ).toEqual(["X", "Y"]);
  });
});

describe("filters", () => {
  test("quick filter searches ric and description with casings", () => {
    expect(quickFilterExpression("")).toBe("");
    const f = quickFilterExpression("apple");
    expect(f).toContain('ric contains "APPLE"');
    expect(f).toContain('description contains "Apple"');
    expect(quickFilterExpression('a"b')).not.toContain('a"b');
  });

  test("combines simulated, watchlist and search", () => {
    expect(buildInstrumentGridFilter({})).toBe("");
    expect(buildInstrumentGridFilter({ watchlistRics: [] })).toBe(
      'ric in ["-"]',
    );
    const f = buildInstrumentGridFilter({
      simulatedOnly: true,
      watchlistRics: ["A.L", "B.L"],
      quickFilter: "a",
    });
    expect(
      f.startsWith('simulated = true and ric in ["A.L","B.L"] and ('),
    ).toBe(true);
  });
});

describe("columns preset", () => {
  test("drops columns absent from the data source (prices only)", () => {
    const prices = ["ric", "bid", "ask", "last", "change", "phase"];
    const { all, visible } = instrumentGridColumns({ available: prices });
    expect(visible.map((c) => c.name)).toEqual([
      "ric",
      "bid",
      "ask",
      "last",
      "change",
      "phase",
      "sparkline",
    ]);
    expect(all.some((c) => c.name === "description")).toBe(false);
  });

  test("sparkline can be disabled", () => {
    const { visible } = instrumentGridColumns({
      available: ["ric", "last"],
      sparkline: false,
    });
    expect(visible.map((c) => c.name)).toEqual(["ric", "last"]);
  });
});
