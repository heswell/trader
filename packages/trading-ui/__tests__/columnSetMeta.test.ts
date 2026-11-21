import { describe, expect, test } from "bun:test";
import type { QuickFilterValue } from "@vuu-ui/vuu-filters";
import type { ColumnSetsState } from "@vuu-ui/vuu-table-extras";
import {
  alsoAppliedValues,
  parseColumnSetMeta,
  quickFilterChipLabel,
  quickFilterColumnsFor,
  reconcileColumnSetMeta,
} from "../src/components/InstrumentGrid/columnSetMeta";

const sets = (...names: string[]): ColumnSetsState => ({
  activeColumnSet: names[0],
  columnSets: names.map((name) => ({
    name,
    columns: ["ric"],
    savedColumns: ["ric"],
  })),
});

const exchange: QuickFilterValue = { op: "=", value: "XLON" };
const sector: QuickFilterValue = { op: "=", value: "Energy" };
const pe: QuickFilterValue = { op: "between-inclusive", value: ["5", "12"] };

describe("column set meta", () => {
  test("parse is defensive", () => {
    expect(parseColumnSetMeta(undefined)).toBeUndefined();
    expect(parseColumnSetMeta("[]")).toBeUndefined();
    expect(parseColumnSetMeta("nope")).toBeUndefined();
    expect(
      parseColumnSetMeta(
        '{"A":{"quickFilterColumns":["x","x","y"]},"B":{"quickFilterColumns":3}}',
      ),
    ).toEqual({ A: { quickFilterColumns: ["x", "y"] }, B: {} });
  });

  test("a set without meta uses the defaults", () => {
    const meta = { A: { quickFilterColumns: ["pe"] } };
    expect(quickFilterColumnsFor(meta, "A", ["exchange"])).toEqual(["pe"]);
    expect(quickFilterColumnsFor(meta, "B", ["exchange"])).toEqual([
      "exchange",
    ]);
    expect(quickFilterColumnsFor(meta, undefined, ["x"])).toEqual(["x"]);
  });

  test("created sets take the fields in view; renames move; deletes drop", () => {
    const meta = { A: { quickFilterColumns: ["pe"] } };
    const created = reconcileColumnSetMeta(
      meta,
      sets("A"),
      sets("A", "B"),
      "created",
      ["sector"],
    );
    expect(created.B).toEqual({ quickFilterColumns: ["sector"] });
    const renamed = reconcileColumnSetMeta(
      created,
      sets("A", "B"),
      sets("C", "B"),
      "renamed",
      [],
    );
    expect(renamed).toEqual({
      B: { quickFilterColumns: ["sector"] },
      C: { quickFilterColumns: ["pe"] },
    });
    expect(
      reconcileColumnSetMeta(renamed, sets("C", "B"), sets("B"), "deleted", []),
    ).toEqual({ B: { quickFilterColumns: ["sector"] } });
    // nothing added or removed: the same object
    expect(
      reconcileColumnSetMeta(meta, sets("A"), sets("A"), "edited", []),
    ).toBe(meta);
  });
});

describe("quick filter values across column sets", () => {
  test("values on fields out of view become Also applied", () => {
    const values = { exchange, pe, sector };
    expect(alsoAppliedValues(values, ["sector", "pe"])).toEqual([
      { column: "exchange", value: exchange },
    ]);
    expect(alsoAppliedValues(values, ["exchange", "sector", "pe"])).toEqual([]);
    expect(alsoAppliedValues({}, [])).toEqual([]);
  });

  test("chip labels", () => {
    const columns = [
      { name: "exchange", label: "Exchange" },
      { name: "sector" },
    ];
    expect(quickFilterChipLabel("exchange", exchange, columns)).toBe(
      "Exchange: XLON",
    );
    expect(quickFilterChipLabel("sector", sector, columns)).toBe(
      "sector: Energy",
    );
    expect(quickFilterChipLabel("pe", pe, columns)).toBe("pe: 5–12");
    expect(
      quickFilterChipLabel("pe", { op: "between", value: ["5", ""] }, columns),
    ).toBe("pe: 5");
    expect(
      quickFilterChipLabel("pe", { op: "between", value: ["", "12"] }, columns),
    ).toBe("pe: < 12");
    expect(quickFilterChipLabel("pe", { op: "<", value: 12 }, columns)).toBe(
      "pe: < 12",
    );
  });
});
