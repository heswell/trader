import { describe, expect, test } from "bun:test";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { Filter } from "@vuu-ui/vuu-filter-types";
import {
  buildInstrumentGridFilter,
  COLUMN_SETS_SETTINGS_KEY,
  createMemorySettingsStorage,
  DEFAULT_INSTRUMENT_GRID_COLUMNS,
  defaultColumnSets,
  gridSettingsKey,
  instrumentGridColumns,
  parseColumnSets,
  parseFilterState,
  SCREENING_COLUMNS,
  useStoredSetting,
  titleCaseColumnName,
} from "../src";

describe("column sets settings", () => {
  test("parses saved column sets, dropping malformed and duplicate sets", () => {
    const json = JSON.stringify({
      activeColumnSet: "Screening",
      columnSets: [
        { name: "Watchlist", columns: ["ric", "last"], savedColumns: ["ric"] },
        { name: "Screening", columns: ["ric", "pe"] },
        { name: "Screening", columns: ["ric"] },
        { name: 1, columns: ["ric"] },
        { name: "Bad", columns: [1] },
      ],
    });
    expect(parseColumnSets(json)).toEqual({
      activeColumnSet: "Screening",
      columnSets: [
        { name: "Watchlist", columns: ["ric", "last"], savedColumns: ["ric"] },
        {
          name: "Screening",
          columns: ["ric", "pe"],
          savedColumns: ["ric", "pe"],
        },
      ],
    });
  });

  test("an active set that doesn't exist is dropped", () => {
    const json = JSON.stringify({
      activeColumnSet: "Gone",
      columnSets: [{ name: "A", columns: ["ric"], savedColumns: ["ric"] }],
    });
    expect(parseColumnSets(json)?.activeColumnSet).toBeUndefined();
  });

  test("nothing saved or unreadable", () => {
    expect(parseColumnSets(null)).toBeUndefined();
    expect(parseColumnSets("not json")).toBeUndefined();
    expect(parseColumnSets("{}")).toBeUndefined();
  });

  test("defaults: Watchlist and Screening, or none without screening columns", () => {
    const state = defaultColumnSets(["ric", "last"], ["ric", "pe"]);
    expect(state.activeColumnSet).toBe("Watchlist");
    expect(state.columnSets.map(({ name }) => name)).toEqual([
      "Watchlist",
      "Screening",
    ]);
    expect(state.columnSets[1]).toEqual({
      name: "Screening",
      columns: ["ric", "pe"],
      savedColumns: ["ric", "pe"],
    });
    expect(defaultColumnSets(["ric"], []).columnSets).toEqual([]);
  });

  test("settings are kept per grid id", () => {
    expect(gridSettingsKey(COLUMN_SETS_SETTINGS_KEY)).toBe(
      COLUMN_SETS_SETTINGS_KEY,
    );
    expect(gridSettingsKey(COLUMN_SETS_SETTINGS_KEY, "grid-1")).toBe(
      `${COLUMN_SETS_SETTINGS_KEY}:grid-1`,
    );
  });
});

describe("filter settings", () => {
  test("parses saved filters, dropping out of range active indices", () => {
    const filters: Filter[] = [
      { column: "pe", op: "<", value: 12 },
      {
        op: "and",
        filters: [
          { column: "exchange", op: "=", value: "XLON" },
          { column: "marketCapUsd", op: ">", value: 30e9 },
        ],
      },
    ];
    expect(
      parseFilterState(JSON.stringify({ filters, activeIndices: [1, 5, -1] })),
    ).toEqual({ filters, activeIndices: [1] });
  });

  test("unreadable filters are ignored", () => {
    expect(parseFilterState(undefined)).toBeUndefined();
    expect(parseFilterState("[")).toBeUndefined();
    expect(
      parseFilterState(JSON.stringify({ filters: [{ name: "x" }] })),
    ).toBeUndefined();
  });
});

describe("stored setting", () => {
  test("reads once, then saves", async () => {
    const storage = createMemorySettingsStorage({ key: '"saved"' });
    const parse = (json: string | null | undefined) =>
      json ? (JSON.parse(json) as string) : undefined;
    const { result } = renderHook(() =>
      useStoredSetting(storage, "key", parse),
    );
    expect(result.current.loaded).toBe(false);
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.value).toBe("saved");
    act(() => result.current.save("changed"));
    expect(storage.getItem("key")).toBe('"changed"');
  });
});

describe("screening columns", () => {
  test("hidden by default, offered by the picker", () => {
    const available = ["ric", "last", ...SCREENING_COLUMNS];
    const { all, visible } = instrumentGridColumns({ available });
    for (const name of SCREENING_COLUMNS) {
      expect(DEFAULT_INSTRUMENT_GRID_COLUMNS).not.toContain(name);
      expect(visible.some((c) => c.name === name)).toBe(false);
      expect(all.some((c) => c.name === name)).toBe(true);
    }
    expect(all.find((c) => c.name === "marketCapUsd")?.label).toBe("Mkt Cap $");
    expect(all.find((c) => c.name === "ric")?.label).toBe("RIC");
  });

  test("a column with no preset is labelled in Title Case", () => {
    expect(titleCaseColumnName("bidSize")).toBe("Bid Size");
    expect(titleCaseColumnName("ric2Code")).toBe("Ric2 Code");
    const { all } = instrumentGridColumns({ available: ["lastTradeTime"] });
    expect(all[0].label).toBe("Last Trade Time");
  });
});

describe("FilterBar filter", () => {
  test("alone", () => {
    expect(buildInstrumentGridFilter({ userFilter: "pe < 12" })).toBe(
      "pe < 12",
    );
  });

  test("and-ed with the grid's own filters", () => {
    expect(
      buildInstrumentGridFilter({
        instrumentType: "EQUITY",
        userFilter: 'pe < 12 or exchange = "XLON"',
      }),
    ).toBe('instrumentType = "EQUITY" and (pe < 12 or exchange = "XLON")');
  });
});
