import { describe, expect, test } from "bun:test";
import {
  EXCHANGE_MODULE,
  OMS_MODULE,
  Side,
  columnIndices,
  defineJoin,
  defineTable,
  depth,
  depthKey,
  fromRowArray,
  getTradingSchemas,
  instrumentPrices,
  joinTableColumns,
  parseDepthKey,
  parsePositionKey,
  positionKey,
  positionPrices,
  prices,
  toRowArray,
  toTableSchema,
  tradingJoins,
  tradingTables,
  type PriceRow,
} from "../src";

describe("table definitions", () => {
  test("modules", () => {
    for (const t of ["instruments", "prices", "depth", "trades"] as const) {
      expect(tradingTables[t].module).toBe(EXCHANGE_MODULE);
    }
    for (const t of [
      "accounts",
      "parentOrders",
      "childOrders",
      "fills",
      "positions",
    ] as const) {
      expect(tradingTables[t].module).toBe(OMS_MODULE);
    }
  });

  test("links reference existing parent tables and columns", () => {
    const all = { ...tradingTables, ...tradingJoins };
    for (const table of Object.values(tradingTables)) {
      for (const link of table.links ?? []) {
        const parent = all[link.toTable as keyof typeof all];
        expect(parent).toBeDefined();
        const cols =
          "baseTable" in parent ? joinTableColumns(parent) : parent.columns;
        expect(cols.map((c) => c.name)).toContain(link.toColumn);
      }
    }
  });

  test("defineTable / defineJoin validation", () => {
    expect(() =>
      defineTable({
        module: "M",
        name: "t",
        // @ts-expect-error keyField must be a column
        keyField: "x",
        columns: [{ name: "a", dataType: "string" }] as const,
      }),
    ).toThrow("keyField");
    expect(() =>
      defineTable({
        module: "M",
        name: "t",
        keyField: "a",
        columns: [
          { name: "a", dataType: "string" },
          { name: "a", dataType: "int" },
        ],
      }),
    ).toThrow("duplicate");
    expect(() =>
      defineJoin({ ...instrumentPrices, joinColumns: ["nope"] }),
    ).toThrow("not in join table");
  });

  test("join columns skip collisions and honour joinColumns", () => {
    const names = joinTableColumns(positionPrices).map((c) => c.name);
    expect(names.filter((n) => n === "ric")).toHaveLength(1);
    expect(names.slice(-6)).toEqual([
      "bid",
      "ask",
      "last",
      "change",
      "changePct",
      "phase",
    ]);
    const ip = joinTableColumns(instrumentPrices).map((c) => c.name);
    expect(ip).toContain("vwap");
    expect(new Set(ip).size).toBe(ip.length);
  });

  test("keys", () => {
    expect(depthKey("VOD.L", Side.Buy, 0)).toBe("VOD.L|BUY|0");
    expect(parseDepthKey("VOD.L|SELL|3")).toEqual({
      ric: "VOD.L",
      side: Side.Sell,
      level: 3,
    });
    expect(positionKey("ACC1", "VOD.L")).toBe("ACC1|VOD.L");
    expect(parsePositionKey("ACC1|VOD.L")).toEqual({
      account: "ACC1",
      ric: "VOD.L",
    });
    expect(() => parseDepthKey("x")).toThrow();
  });

  test("row array round trip with defaults", () => {
    const row: Partial<PriceRow> = {
      ric: "VOD.L",
      bid: 100,
      ask: 100.5,
      phase: "CONTINUOUS",
    };
    const arr = toRowArray(prices, row);
    expect(arr).toHaveLength(prices.columns.length);
    const idx = columnIndices(prices);
    expect(arr[idx.ask]).toBe(100.5);
    expect(arr[idx.volume]).toBe(0);
    expect(fromRowArray(prices, arr)).toMatchObject(row);
    expect(toRowArray(depth, { id: "x" })[columnIndices(depth).side]).toBe("");
  });
});

describe("TableSchema adapter", () => {
  test("table schema", () => {
    expect(toTableSchema(prices)).toEqual({
      table: { module: "EXCHANGE", table: "prices" },
      key: "ric",
      columns: prices.columns.map(({ name, dataType }) => ({
        name,
        serverDataType: dataType,
      })),
    });
  });

  test("join schema uses base key and module", () => {
    const s = toTableSchema(positionPrices);
    expect(s.key).toBe("id");
    expect(s.table).toEqual({ module: "OMS", table: "positionPrices" });
    expect(s.columns.find((c) => c.name === "last")?.serverDataType).toBe(
      "double",
    );
  });

  test("getTradingSchemas covers all tables and joins", () => {
    expect(Object.keys(getTradingSchemas()).sort()).toEqual(
      [...Object.keys(tradingTables), ...Object.keys(tradingJoins)].sort(),
    );
  });
});
