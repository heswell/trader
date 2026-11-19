import { describe, expect, test } from "bun:test";
import type { Filter } from "@vuu-ui/vuu-filter-types";
import type { ColumnSetsState } from "@vuu-ui/vuu-table-extras";
import {
  alsoAppliedFilters,
  andFilters,
  parseColumnSetMeta,
  quickFilterChipLabel,
  quickFilterClauses,
  quickFilterColumnsFor,
  reconcileColumnSetMeta,
  updateQuickFilterValues,
} from "../src/components/InstrumentGrid/columnSetMeta";

const sets = (...names: string[]): ColumnSetsState => ({
  activeColumnSet: names[0],
  columnSets: names.map((name) => ({
    name,
    columns: ["ric"],
    savedColumns: ["ric"],
  })),
});

const exchange: Filter = { column: "exchange", op: "=", value: "XLON" };
const sector: Filter = {
  column: "sector",
  op: "in",
  values: ["Energy", "Financials"],
} as Filter;
const search: Filter = {
  op: "or",
  filters: [
    { column: "ric", op: "contains", value: "ba" },
    { column: "description", op: "contains", value: "ba" },
  ],
};
const pe: Filter = {
  op: "and",
  filters: [
    { column: "pe", op: ">=", value: 5 },
    { column: "pe", op: "<=", value: 12 },
  ],
};

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
  test("clauses split by column, without the search", () => {
    const combined: Filter = {
      op: "and",
      filters: [{ op: "and", filters: [exchange, sector, pe] }, search],
    };
    expect(quickFilterClauses(combined, ["ric", "description"])).toEqual({
      exchange,
      pe,
      sector,
    });
    expect(quickFilterClauses(exchange, [])).toEqual({ exchange });
    expect(quickFilterClauses(search, ["ric", "description"])).toEqual({});
    expect(quickFilterClauses(undefined, [])).toEqual({});
  });

  test("values on fields out of view are kept and become Also applied", () => {
    let values = updateQuickFilterValues({}, { exchange, sector }, [
      "exchange",
      "sector",
    ]);
    // switch to a set without exchange: its value stays
    values = updateQuickFilterValues(values, { sector }, ["sector", "pe"]);
    expect(values).toEqual({ exchange, sector });
    expect(alsoAppliedFilters(values, ["sector", "pe"])).toEqual([
      { column: "exchange", filter: exchange },
    ]);
    // a field in view with no clause was cleared
    values = updateQuickFilterValues(values, {}, ["sector", "pe"]);
    expect(values).toEqual({ exchange });
  });

  test("andFilters flattens and leaves a between whole", () => {
    expect(andFilters(undefined, [])).toBeUndefined();
    expect(andFilters(exchange, [])).toBe(exchange);
    expect(
      andFilters({ op: "and", filters: [exchange, sector] }, [pe]),
    ).toEqual({ op: "and", filters: [exchange, sector, pe] });
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
      "sector: Energy, Financials",
    );
    expect(quickFilterChipLabel("pe", pe, columns)).toBe("pe: 5–12");
    expect(
      quickFilterChipLabel("pe", { column: "pe", op: "<", value: 12 }, columns),
    ).toBe("pe: < 12");
  });
});
