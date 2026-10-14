import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { exchangeTables, getTradingSchemas } from "@heswell/trading-schemas";
import type { SelectRowRequest } from "@vuu-ui/vuu-protocol-types";
import {
  type ModuleDataSource,
  STALE_UPDATE,
} from "@heswell/vuu-data-engine-local";
import { StaleUpdateError } from "@vuu-ui/vuu-utils";
import {
  createTradingTestData,
  EXCHANGE_TABLE_NAMES,
  type ExchangeTableName,
  setCurrentUser,
  type TradingTestData,
  visualLinksFor,
} from "../src";
import { collector, tick } from "./helpers";

const ADMIN = { name: "admin", authorizations: [] };
const VIEWER = { name: "viewer", authorizations: ["trading-supervisor"] };
const RANGE = { from: 0, to: 500 };

let td: TradingTestData;

beforeEach(() => {
  setCurrentUser({ name: "user", authorizations: [] });
  td = createTradingTestData({
    seed: 1,
    manualClock: true,
    exchange: { activeInstruments: 10 },
    oms: { flowRate: 0 },
  });
});
afterEach(() => td.dispose());

const ricAt = (i: number) => td.sim.books[i].ric;
const openSession = async (ds: ModuleDataSource) => {
  const session = (await ds.beginEditSession?.()) as
    | ModuleDataSource
    | undefined;
  if (!session) throw Error("no edit session");
  await session.subscribe({ range: RANGE }, () => undefined);
  return session;
};
/** A resting ACC-US-01 limit buy, 5% below the bid. */
const restingOrder = () => {
  td.advance(500);
  const ric = ricAt(0);
  const prices = td.exchange.getTable("prices");
  const bid = prices.findByKey(ric)?.[prices.map.bid] as number;
  const created = td.rpc(
    "createOrder",
    {
      account: "ACC-US-01",
      ric,
      side: "BUY",
      ordType: "LIMIT",
      quantity: 100,
      price: Math.floor(bid * 0.95),
    },
    ADMIN,
  );
  expect(created).toMatchObject({ type: "SUCCESS_RESULT" });
  td.advance(100);
  return (created as { data: { orderId: string } }).data.orderId;
};
const createDs = <T extends string>(
  module: { createDataSource: (table: T) => unknown },
  table: T,
) => module.createDataSource(table) as ModuleDataSource;

describe("schemas", () => {
  test("every table publishes the trading-schemas TableSchema", () => {
    const expected = getTradingSchemas();
    for (const [name, schema] of Object.entries(td.schemas)) {
      expect(schema).toEqual(expected[name as keyof typeof expected]);
    }
  });

  test("visual links come from the table definitions", () => {
    expect(
      visualLinksFor<ExchangeTableName>(exchangeTables, EXCHANGE_TABLE_NAMES)
        .depth,
    ).toEqual([
      { fromColumn: "ric", toTable: "prices", toColumn: "ric" },
      { fromColumn: "ric", toTable: "instrumentPrices", toColumn: "ric" },
    ]);
  });
});

describe("determinism", () => {
  test("the same seed and manual clock produce the same prices", () => {
    td.advance(2_000);
    const a = td.exchange.getTable("prices").data.map((r) => [...r]);
    td.dispose();
    td = createTradingTestData({
      seed: 1,
      manualClock: true,
      exchange: { activeInstruments: 10 },
      oms: { flowRate: 0 },
    });
    td.advance(2_000);
    expect(td.exchange.getTable("prices").data.map((r) => [...r])).toEqual(a);
  });

  test("two instances are independent (each has its own engine)", () => {
    const other = createTradingTestData({
      seed: 2,
      manualClock: true,
      exchange: { activeInstruments: 5 },
      oms: { flowRate: 0 },
    });
    expect(other.engine).not.toBe(td.engine);
    expect(
      other.engine.tableContainer.getTable({
        module: "EXCHANGE",
        table: "prices",
      }),
    ).toBe(other.exchange.getTable("prices"));
    expect(
      td.engine.tableContainer.getTable({
        module: "EXCHANGE",
        table: "prices",
      }),
    ).toBe(td.exchange.getTable("prices"));
    other.advance(500);
    td.advance(500);
    expect(
      other.rpc(
        "createOrder",
        {
          account: "ACC-US-01",
          ric: other.sim.books[0].ric,
          side: "BUY",
          ordType: "MARKET",
          quantity: 10,
        },
        ADMIN,
      ).type,
    ).toBe("SUCCESS_RESULT");
    expect(other.oms.getTable("parentOrders").data.length).toBe(1);
    expect(td.oms.getTable("parentOrders").data.length).toBe(0);
    other.dispose();
    expect(td.engine.getTableList().length).toBe(11);
  });

  test("advance requires a manual clock", () => {
    const live = createTradingTestData({ autoStart: false });
    expect(() => live.advance(10)).toThrow();
    live.dispose();
  });
});

describe("data sources", () => {
  test("prices tick through a subscribed data source", async () => {
    const ds = createDs(td.exchange, "prices");
    const c = collector();
    await ds.subscribe({ range: RANGE }, c.callback);
    await tick();
    const ric = ricAt(0);
    const lastFor = () => c.rows().find((r) => r[ds.columnMap.ric] === ric);
    const before = JSON.stringify(lastFor());
    let changed = false;
    for (let i = 0; i < 20 && !changed; i++) {
      td.advance(500);
      await tick();
      changed = JSON.stringify(lastFor()) !== before;
    }
    expect(changed).toBe(true);
    ds.unsubscribe();
  });

  test("sort, filter and groupBy run in the local engine", async () => {
    const ds = createDs(td.exchange, "instrumentPrices");
    const c = collector();
    await ds.subscribe(
      { range: RANGE, columns: ["ric", "exchange", "currency", "last"] },
      c.callback,
    );
    await tick();
    const total = c.size;
    expect(total).toBeGreaterThan(0);

    ds.sort = { sortDefs: [{ column: "ric", sortType: "D" }] };
    await tick();
    const rics = c.rows().map((r) => String(r[ds.columnMap.ric]));
    expect(rics).toEqual([...rics].sort().reverse());

    ds.filter = { filter: 'exchange = "XLON"' };
    await tick();
    expect(c.size).toBeGreaterThan(0);
    expect(c.size).toBeLessThanOrEqual(total);
    expect(c.rows().every((r) => r[ds.columnMap.exchange] === "XLON")).toBe(
      true,
    );

    ds.filter = { filter: "" };
    ds.groupBy = ["exchange"];
    await tick();
    expect(c.size).toBeGreaterThan(0);
    expect(c.size).toBeLessThan(total);
    ds.unsubscribe();
  });
});

describe("visual links", () => {
  test("depth links to a selected instrumentPrices row", async () => {
    const parent = createDs(td.exchange, "instrumentPrices");
    const pc = collector();
    await parent.subscribe({ range: RANGE }, pc.callback);
    const child = createDs(td.exchange, "depth");
    const cc = collector();
    await child.subscribe({ range: RANGE }, cc.callback);
    td.advance(500);
    await tick();
    const all = cc.size;

    const links = td.exchange.getVisualLinks("depth") ?? [];
    const link = links.find(({ link }) => link.toTable === "instrumentPrices");
    expect(link).toBeDefined();
    child.visualLink = link;
    const ric = String(pc.rows()[0][parent.columnMap.ric]);
    const selectRow: Omit<SelectRowRequest, "vpId"> = {
      type: "SELECT_ROW",
      rowKey: ric,
      preserveExistingSelection: false,
    };
    parent.select(selectRow as Parameters<typeof parent.select>[0]);
    await tick(50);
    expect(cc.size).toBeGreaterThan(0);
    expect(cc.size).toBeLessThan(all);
    expect(cc.rows().every((r) => r[child.columnMap.ric] === ric)).toBe(true);
    child.unsubscribe();
    parent.unsubscribe();
  });
});

describe("OMS rpc", () => {
  test("createOrder via dataSource.rpcRequest fills and updates positions", async () => {
    setCurrentUser(ADMIN);
    td.advance(500);
    const ds = createDs(td.oms, "parentOrders");
    const c = collector();
    await ds.subscribe({ range: RANGE }, c.callback);
    const result = await ds.rpcRequest?.({
      type: "RPC_REQUEST",
      rpcName: "createOrder",
      params: {
        account: "ACC-US-01",
        ric: ricAt(0),
        side: "BUY",
        ordType: "MARKET",
        quantity: 100,
      },
    });
    expect(result?.type).toBe("SUCCESS_RESULT");
    const { orderId } = (result as { data: { orderId: string } }).data;
    td.advance(200);
    await tick();
    expect(c.size).toBe(1);
    expect(c.rows()[0][ds.columnMap.orderId]).toBe(orderId);
    expect(td.oms.getTable("fills").data.length).toBeGreaterThan(0);
    const positions = td.oms.getTable("positionPrices");
    expect(positions.data.length).toBe(1);
    ds.unsubscribe();
  });

  test("errors use the server's CODE: message format", () => {
    const result = td.rpc(
      "createOrder",
      {
        account: "NOPE",
        ric: ricAt(0),
        side: "BUY",
        ordType: "MARKET",
        quantity: 1,
      },
      ADMIN,
    );
    expect(result).toMatchObject({ type: "ERROR_RESULT" });
    expect((result as { errorMessage: string }).errorMessage).toMatch(
      /^UNKNOWN_ACCOUNT: /,
    );
  });

  test("permission filter restricts OMS rows to the user's accounts", async () => {
    td.rpc(
      "createOrder",
      {
        account: "ACC-US-01",
        ric: ricAt(0),
        side: "BUY",
        ordType: "MARKET",
        quantity: 10,
      },
      ADMIN,
    );
    td.rpc(
      "createOrder",
      {
        account: "ACC-EU-01",
        ric: ricAt(1),
        side: "SELL",
        ordType: "MARKET",
        quantity: 10,
      },
      ADMIN,
    );
    td.advance(200);
    setCurrentUser({ name: "alice", authorizations: [] });
    const ds = createDs(td.oms, "parentOrders");
    const c = collector();
    await ds.subscribe({ range: RANGE }, c.callback);
    await tick();
    expect(c.size).toBe(1);
    expect(c.rows()[0][ds.columnMap.account]).toBe("ACC-US-01");
    ds.unsubscribe();
  });

  test("saving a parentOrders edit session amends via the OMS", async () => {
    setCurrentUser(ADMIN);
    td.advance(500);
    const ric = ricAt(0);
    const prices = td.exchange.getTable("prices");
    const bid = prices.findByKey(ric)?.[prices.map.bid] as number;
    const ds = createDs(td.oms, "parentOrders");
    const c = collector();
    await ds.subscribe({ range: RANGE }, c.callback);
    const created = td.rpc("createOrder", {
      account: "ACC-US-01",
      ric,
      side: "BUY",
      ordType: "LIMIT",
      quantity: 100,
      price: Math.floor(bid * 0.95),
    });
    expect(created).toMatchObject({ type: "SUCCESS_RESULT" });
    const { orderId } = (created as { data: { orderId: string } }).data;
    td.advance(100);

    const session = await openSession(ds);
    await session.editCell?.(orderId, "quantity", 200);
    await session.endEditSession?.(true);
    td.advance(100);

    const orders = td.oms.getTable("parentOrders");
    const row = orders.findByKey(orderId);
    expect(row?.[orders.map.quantity]).toBe(200);
    // version 0 -> 1 proves the OMS amended (a direct write keeps 0)
    expect(row?.[orders.map.version]).toBe(1);
    ds.unsubscribe();
  });

  test("deleting a row in a parentOrders edit session cancels the order", async () => {
    setCurrentUser(ADMIN);
    const ds = createDs(td.oms, "parentOrders");
    await ds.subscribe({ range: RANGE }, () => undefined);
    const orderId = restingOrder();
    const session = await openSession(ds);
    await session.deleteRow?.(orderId);
    await session.endEditSession?.(true);
    td.advance(100);
    const orders = td.oms.getTable("parentOrders");
    expect(orders.findByKey(orderId)?.[orders.map.status]).toBe("CANCELLED");
    ds.unsubscribe();
  });

  test("only quantity and price are editable, and only in a session", async () => {
    setCurrentUser(ADMIN);
    const ds = createDs(td.oms, "parentOrders");
    await ds.subscribe({ range: RANGE }, () => undefined);
    const orderId = restingOrder();
    expect(await ds.editCell?.(orderId, "quantity", 200)).toMatchObject({
      type: "ERROR_RESULT",
    });
    const session = await openSession(ds);
    expect(await session.editCell?.(orderId, "account", "X")).toMatchObject({
      type: "ERROR_RESULT",
    });
    // amendOrder validation (quantity must be positive)
    expect(await session.editCell?.(orderId, "quantity", -1)).toMatchObject({
      type: "ERROR_RESULT",
    });
    expect(
      await session.rpcRequest?.({
        type: "RPC_REQUEST",
        rpcName: "addRow",
        params: { key: "NEW", data: {} },
      }),
    ).toMatchObject({
      type: "ERROR_RESULT",
      errorMessage: "addRow: use createOrder to enter orders",
    });
    await session.endEditSession?.(false);
    ds.unsubscribe();
  });

  test("a save after the order changed is refused as a stale update", async () => {
    setCurrentUser(ADMIN);
    const ds = createDs(td.oms, "parentOrders");
    await ds.subscribe({ range: RANGE }, () => undefined);
    const orderId = restingOrder();
    const session = await openSession(ds);
    await session.editCell?.(orderId, "quantity", 300);
    // another user's amend bumps the order's version under the session
    expect(td.rpc("amendOrder", { orderId, quantity: 200 }, ADMIN).type).toBe(
      "SUCCESS_RESULT",
    );
    td.advance(100);
    const error = await session.endEditSession?.(true).catch((err) => err);
    expect(error).toBeInstanceOf(StaleUpdateError);
    expect(error.message).toBe(STALE_UPDATE);
    const orders = td.oms.getTable("parentOrders");
    expect(orders.findByKey(orderId)?.[orders.map.quantity]).toBe(200);
    await session.endEditSession?.(false);
    ds.unsubscribe();
  });

  test("a user without trading-execute cannot save a session", async () => {
    setCurrentUser(ADMIN);
    const orderId = restingOrder();
    setCurrentUser(VIEWER);
    const ds = createDs(td.oms, "parentOrders");
    await ds.subscribe({ range: RANGE }, () => undefined);
    const session = await openSession(ds);
    await session.editCell?.(orderId, "quantity", 300);
    const error = await session.endEditSession?.(true).catch((err) => err);
    expect(String(error?.message)).toMatch(/^PERMISSION_DENIED: /);
    ds.unsubscribe();
  });

  test("exchange admin rpc (haltInstrument) is available", () => {
    const result = td.rpc("haltInstrument", { ric: ricAt(0) }, ADMIN);
    expect(result.type).toBe("SUCCESS_RESULT");
  });
});
