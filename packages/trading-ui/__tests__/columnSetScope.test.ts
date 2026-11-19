import { describe, expect, test } from "bun:test";
import type { ColumnSetsState } from "@vuu-ui/vuu-table-extras";
import {
  columnSetForScope,
  columnSetsInScope,
  columnSetsOnlyIn,
  copyName,
  followColumnSets,
  parseLastColumnSet,
  setColumnSetScope,
  tabOrder,
} from "../src/components/InstrumentGrid/columnSetScope";

const state = (
  active: string | undefined,
  ...names: string[]
): ColumnSetsState => ({
  activeColumnSet: active,
  columnSets: names.map((name) => ({ name, columns: [], savedColumns: [] })),
});

const sets = ["Prices", "Banks view", "Screening", "All only"].map((name) => ({
  name,
}));
const meta = {
  "All only": { scope: "__all__" },
  "Banks view": { quickFilterColumns: ["sector"], scope: "banks" },
  Prices: {},
};

describe("column set scope", () => {
  test("a scope shows the shared sets, then its own", () => {
    const banks = columnSetsInScope(sets, meta, "banks");
    expect(banks).toEqual({
      scoped: ["Banks view"],
      shared: ["Prices", "Screening"],
    });
    expect(tabOrder(banks)).toEqual(["Prices", "Screening", "Banks view"]);
    expect(columnSetsInScope(sets, meta, "__all__").scoped).toEqual([
      "All only",
    ]);
  });

  test("entering a scope shows its last set, else the one in view, else the first", () => {
    const banks = columnSetsInScope(sets, meta, "banks");
    expect(
      columnSetForScope(banks, { banks: "Banks view" }, "banks", "Prices"),
    ).toBe("Banks view");
    expect(
      columnSetForScope(banks, { banks: "Gone" }, "banks", "Screening"),
    ).toBe("Screening");
    expect(columnSetForScope(banks, {}, "banks", "All only")).toBe("Prices");
  });

  test("share, keep to one scope, and the sets only in a scope", () => {
    const kept = setColumnSetScope(meta, "Prices", "banks");
    expect(kept.Prices).toEqual({ scope: "banks" });
    expect(columnSetsOnlyIn(kept, "banks").sort()).toEqual([
      "Banks view",
      "Prices",
    ]);
    expect(
      setColumnSetScope(kept, "Banks view", undefined)["Banks view"],
    ).toEqual({
      quickFilterColumns: ["sector"],
    });
  });

  test("the last-set record follows activations, renames and deletes", () => {
    let last = followColumnSets(
      {},
      state("A", "A", "B"),
      state("B", "A", "B"),
      "banks",
    );
    expect(last).toEqual({ banks: "B" });
    last = followColumnSets(
      last,
      state("B", "A", "B"),
      state("C", "A", "C"),
      "banks",
    );
    expect(last).toEqual({ banks: "C" });
    last = followColumnSets(
      { __all__: "A", banks: "C" },
      state("A", "A", "C"),
      state(undefined, "C"),
      "__all__",
    );
    expect(last).toEqual({ banks: "C" });
  });

  test("copy names and a defensive parse", () => {
    expect(copyName("Prices", ["Prices"])).toBe("Prices copy");
    expect(copyName("Prices", ["Prices", "prices copy"])).toBe("Prices copy 2");
    expect(parseLastColumnSet('{"a":"X","b":3}')).toEqual({ a: "X" });
    expect(parseLastColumnSet("[]")).toBeUndefined();
    expect(parseLastColumnSet(undefined)).toBeUndefined();
  });
});
