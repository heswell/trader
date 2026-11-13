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
    expect(td.engine.getTableList().length).toBe(37);
  });

  test("advance requires a manual clock", () => {
    const live = createTradingTestData({ autoStart: false });
    expect(() => live.advance(10)).toThrow();
    live.dispose();
  });
});

describe("dispose", () => {
  test("detaches the joins from their sources (no leaked listeners)", () => {
    const other = createTradingTestData({
      seed: 3,
      manualClock: true,
      exchange: { activeInstruments: 5 },
      oms: { flowRate: 0 },
    });
    other.advance(500);
    const ric = other.sim.books[0].ric;
    const prices = other.exchange.getTable("prices");
    const joins = [
      other.exchange.getTable("instrumentPrices"),
      other.oms.getTable("positionPrices"),
    ];
    const bidOf = () =>
      other.exchange.getTable("instrumentPrices").findByKey(ric)?.[
        other.exchange.getTable("instrumentPrices").map.bid
      ];

    prices.update(ric, "bid", 101.5);
    expect(bidOf()).toBe(101.5);

    other.dispose();
    for (const join of joins) expect(join.destroyed).toBe(true);
    prices.update(ric, "bid", 202.5);
    expect(bidOf()).toBe(101.5);
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
    const sector = td.exchange.getTable("instruments").findByKey(ricAt(0))?.[
      td.exchange.getTable("instruments").map.sector
    ];
    expect(sector).toBeTruthy();
    expect(positions.data[0][positions.map.sector]).toBe(sector as string);
    ds.unsubscribe();
  });

  test("positionPrices groups by currency / sector (PositionsView default)", async () => {
    setCurrentUser(ADMIN);
    td.advance(500);
    for (const i of [0, 1, 2, 3]) {
      const created = td.rpc("createOrder", {
        account: "ACC-US-01",
        ric: ricAt(i),
        side: "BUY",
        ordType: "MARKET",
        quantity: td.sim.books[i].instrument.lotSize * 10,
      });
      expect(created.type).toBe("SUCCESS_RESULT");
    }
    td.advance(200);
    const ds = createDs(td.oms, "positionPrices");
    const c = collector();
    await ds.subscribe(
      {
        range: RANGE,
        columns: ["id", "currency", "sector", "totalPnl"],
        groupBy: ["currency", "sector"],
      },
      c.callback,
    );
    await tick();
    const positions = td.oms.getTable("positionPrices");
    const groups = new Set(
      positions.data.map(
        (row) => `${row[positions.map.currency]}|${row[positions.map.sector]}`,
      ),
    );
    expect(positions.data.length).toBeGreaterThan(0);
    // top-level rows are the currency groups
    expect(c.size).toBe(
      new Set(positions.data.map((row) => row[positions.map.currency])).size,
    );
    expect(groups.size).toBeGreaterThan(0);
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

  test("client bots: rows for sim admins only, RPCs, client scenarios listed", async () => {
    const SIM_ADMIN = { name: "root", authorizations: ["sim-admin"] };
    const added = td.rpc(
      "addClientBot",
      { persona: "quant", params: JSON.stringify({ ordersPerMin: 60 }) },
      SIM_ADMIN,
    );
    expect(added).toMatchObject({
      data: { botId: "CB1", account: "CLIENT-01" },
    });
    expect(td.rpc("addClientBot", { persona: "quant" }, VIEWER)).toMatchObject({
      type: "ERROR_RESULT",
    });
    td.advance(5_000);
    const bots = td.oms.getTable("clientBots");
    const row = bots.findByKey("CB1");
    expect(row?.[bots.map.persona]).toBe("quant");
    expect(row?.[bots.map.submitted] as number).toBeGreaterThan(0);
    const params = td.oms.getTable("clientBotParams");
    expect(params.findByKey("CB1|ordersPerMin")?.[params.map.value]).toBe("60");
    // the add's overrides are the baseline; a later change is marked
    expect(params.findByKey("CB1|ordersPerMin")?.[params.map.changed]).toBe(
      false,
    );
    td.rpc(
      "setClientBotParams",
      { botId: "CB1", name: "maxLive", value: "3" },
      SIM_ADMIN,
    );
    td.advance(100);
    expect(params.findByKey("CB1|maxLive")?.[params.map.changed]).toBe(true);
    expect(params.findByKey("CB1|maxLive")?.[params.map.baseline]).toBe("10");
    expect(
      td.exchange
        .getTable("scenarios")
        .data.map((r) => r[td.exchange.getTable("scenarios").map.name]),
    ).toEqual(
      expect.arrayContaining(["client-liquidation", "pension-programme"]),
    );

    setCurrentUser(SIM_ADMIN);
    const admin = createDs(td.oms, "clientBots");
    const a = collector();
    await admin.subscribe({ range: RANGE }, a.callback);
    await tick();
    expect(a.size).toBe(1);
    admin.unsubscribe();
    setCurrentUser(VIEWER);
    const viewer = createDs(td.oms, "clientBots");
    const v = collector();
    await viewer.subscribe({ range: RANGE }, v.callback);
    await tick();
    expect(v.size).toBe(0);
    viewer.unsubscribe();

    td.rpc("removeClientBot", { botId: "CB1" }, SIM_ADMIN);
    td.advance(100);
    expect(bots.findByKey("CB1")).toBeUndefined();
    expect(params.findByKey("CB1|ordersPerMin")).toBeUndefined();
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

  // engine-local >= 4 marks deleted session rows vuuAction="deleteRow" in
  // every mode, so applySessionSave sees the delete and sends cancelOrder
  // (the row stays, CANCELLED, rather than being removed from the table).
  for (const mode of ["hard", "soft"] as const) {
    test(`deleting a row (${mode}) in a parentOrders edit session cancels the order`, async () => {
      setCurrentUser(ADMIN);
      const ds = createDs(td.oms, "parentOrders");
      await ds.subscribe({ range: RANGE }, () => undefined);
      const orderId = restingOrder();
      const session = await openSession(ds);
      expect(await session.deleteRow?.(orderId, mode)).toBe(true);
      await session.endEditSession?.(true);
      td.advance(100);
      const orders = td.oms.getTable("parentOrders");
      expect(orders.findByKey(orderId)?.[orders.map.status]).toBe("CANCELLED");
      ds.unsubscribe();
    });
  }

  test("deleteSelectedRows in a parentOrders edit session cancels the orders", async () => {
    setCurrentUser(ADMIN);
    const ds = createDs(td.oms, "parentOrders");
    await ds.subscribe({ range: RANGE }, () => undefined);
    const orderId = restingOrder();
    const session = await openSession(ds);
    const selectRow: Omit<SelectRowRequest, "vpId"> = {
      type: "SELECT_ROW",
      rowKey: orderId,
      preserveExistingSelection: false,
    };
    session.select(selectRow as Parameters<typeof session.select>[0]);
    await tick();
    expect(await session.deleteSelectedRows?.()).toMatchObject({
      type: "SUCCESS_RESULT",
    });
    await session.endEditSession?.(true);
    td.advance(100);
    const orders = td.oms.getTable("parentOrders");
    expect(orders.findByKey(orderId)?.[orders.map.status]).toBe("CANCELLED");
    ds.unsubscribe();
  });

  test("deleteRow outside an edit session is refused", async () => {
    setCurrentUser(ADMIN);
    const ds = createDs(td.oms, "parentOrders");
    await ds.subscribe({ range: RANGE }, () => undefined);
    const orderId = restingOrder();
    expect(await ds.deleteRow?.(orderId)).toBe(
      "deleteRow: only supported in an edit session",
    );
    const orders = td.oms.getTable("parentOrders");
    expect(orders.findByKey(orderId)?.[orders.map.status]).not.toBe(
      "CANCELLED",
    );
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

describe("chart data", () => {
  test("bars, bookSamples and P&L history populate; P&L history is permission filtered", async () => {
    const local = createTradingTestData({
      seed: 1,
      manualClock: true,
      exchange: { activeInstruments: 5 },
      oms: { flowRate: 0, pnlHistoryIntervalMs: 1_000 },
    });
    try {
      local.advance(500);
      for (const [account, i] of [
        ["ACC-US-01", 0],
        ["ACC-EU-01", 1],
      ] as const) {
        expect(
          local.rpc(
            "createOrder",
            {
              account,
              ric: local.sim.books[i].ric,
              side: "BUY",
              ordType: "MARKET",
              quantity: 10,
            },
            ADMIN,
          ),
        ).toMatchObject({ type: "SUCCESS_RESULT" });
      }
      local.advance(3_000);
      expect(local.exchange.getTable("bars").data.length).toBeGreaterThan(0);
      expect(
        local.exchange.getTable("bookSamples").data.length,
      ).toBeGreaterThan(0);
      expect(local.oms.getTable("pnlHistory").data.length).toBeGreaterThan(0);
      expect(
        local.oms.getTable("accountPnlHistory").data.length,
      ).toBeGreaterThan(0);

      setCurrentUser({ name: "alice", authorizations: [] });
      for (const table of ["pnlHistory", "accountPnlHistory"] as const) {
        const ds = local.oms.createDataSource(table) as ModuleDataSource;
        const c = collector();
        await ds.subscribe({ range: RANGE }, c.callback);
        await tick();
        expect(c.size).toBeGreaterThan(0);
        const accounts = new Set(
          c.rows().map((row) => row[ds.columnMap.account]),
        );
        expect([...accounts]).toEqual(["ACC-US-01"]);
        ds.unsubscribe();
      }
    } finally {
      local.dispose();
    }
  });
});

describe("futures in the local test data", () => {
  test("lists front and next quarter futures with books", () => {
    const local = createTradingTestData({ seed: 1, manualClock: true });
    try {
      const instruments = local.exchange.getTable("instruments");
      const { map } = instruments;
      const futures = instruments.data.filter(
        (row) => row[map.instrumentType] === "FUTURE",
      );
      expect(futures.map((row) => row[map.underlying]).sort()).toEqual([
        "AAPL.OQ",
        "AAPL.OQ",
        "STECH",
        "STECH",
        "VOD.L",
        "VOD.L",
      ]);
      const index = instruments.data.find((row) => row[map.ric] === "STECH");
      expect(index?.[map.instrumentType]).toBe("INDEX");
      expect(futures.every((row) => row[map.simulated] === true)).toBe(true);
      expect(
        futures.every((row) => Number(row[map.contractMultiplier]) > 1),
      ).toBe(true);
    } finally {
      local.dispose();
    }
  });
});

describe("METRICS", () => {
  test("advance takes a snapshot: metrics, table writes and history", () => {
    const local = createTradingTestData({
      seed: 2,
      manualClock: true,
      // no futures: exactly three books
      exchange: { activeInstruments: 3, futures: "" },
      oms: { flowRate: 0 },
    });
    try {
      local.advance(1_000);
      local.advance(1_000);
      const rows = (name: "metrics" | "metricsTables" | "metricsHistory") => {
        const table = local.metrics.getTable(name);
        const { map } = table;
        return table.data.map((row) =>
          Object.fromEntries(
            Object.entries(map).map(([column, i]) => [column, row[i]]),
          ),
        );
      };
      const metrics = rows("metrics");
      expect(metrics.find((r) => r.id === "exchange.books")?.value).toBe(3);
      // timers are on (all) in the local data: the step is timed
      const step = metrics.find((r) => r.id === "exchange.step");
      expect(step?.kind).toBe("timer");
      expect(Number(step?.value)).toBeGreaterThan(0);
      const prices = rows("metricsTables").find(
        (r) => r.id === "EXCHANGE.prices",
      );
      expect(prices?.counted).toBe(true);
      expect(Number(prices?.rows)).toBeGreaterThan(0);
      const history = rows("metricsHistory").filter(
        (r) => r.metric === "exchange.books",
      );
      expect(history.length).toBe(2);
      // the browser has no process stats
      expect(local.metrics.getTable("metricsProcess").data.length).toBe(0);
    } finally {
      local.dispose();
    }
  });
});

describe("order ticket rows (orderEntry)", () => {
  const ALICE = { name: "alice", authorizations: ["trading-execute"] };
  const BOB = { name: "bob", authorizations: ["trading-execute"] };

  test("edits through orderEntryPrices write orderEntry; vuuMsg carries the errors", async () => {
    setCurrentUser(ALICE);
    td.advance(500);
    const ric = ricAt(0);
    const ds = createDs(td.oms, "orderEntryPrices");
    const c = collector();
    await ds.subscribe({ range: RANGE }, c.callback);
    const opened = await ds.rpcRequest?.({
      type: "RPC_REQUEST",
      rpcName: "openOrderEntry",
      params: { ticketId: "t1", ric },
    });
    expect(opened).toMatchObject({
      type: "SUCCESS_RESULT",
      data: { entryId: "alice:t1" },
    });
    const table = td.oms.getTable("orderEntry");
    const value = (column: string) =>
      table.findByKey("alice:t1")?.[table.map[column]];
    expect(value("account")).toBe("ACC-US-01");
    expect(String(value("vuuMsg"))).toContain("MISSING_PRICE");

    // wrong types are refused, a joined price column is not editable
    expect(await ds.editCell?.("alice:t1", "quantity", "abc")).toMatchObject({
      type: "ERROR_RESULT",
    });
    expect(await ds.editCell?.("alice:t1", "bid", 1)).toMatchObject({
      type: "ERROR_RESULT",
    });

    const prices = td.exchange.getTable("prices");
    const bid = prices.findByKey(ric)?.[prices.map.bid] as number;
    expect(await ds.editCell?.("alice:t1", "quantity", 100)).toMatchObject({
      type: "SUCCESS_RESULT",
    });
    expect(await ds.editCell?.("alice:t1", "price", bid)).toMatchObject({
      type: "SUCCESS_RESULT",
    });
    expect(value("quantity")).toBe(100);
    expect(value("vuuMsg")).toBe("");
    // the join row has the draft and the live prices
    const join = td.oms.getTable("orderEntryPrices");
    expect(join.findByKey("alice:t1")?.[join.map.quantity]).toBe(100);
    expect(join.findByKey("alice:t1")?.[join.map.bid]).toBe(bid);

    const sent = await ds.rpcRequest?.({
      type: "RPC_REQUEST",
      rpcName: "sendOrder",
      params: { entryId: "alice:t1" },
    });
    expect(sent).toMatchObject({ type: "SUCCESS_RESULT" });
    const { orderId } = (sent as { data: { orderId: string } }).data;
    expect(value("orderId")).toBe(orderId);
    expect(value("quantity")).toBe(0);
    ds.unsubscribe();
  });

  test("each user sees and edits only their own rows", async () => {
    setCurrentUser(ALICE);
    td.rpc("openOrderEntry", { ticketId: "t1", ric: ricAt(0) }, ALICE);
    setCurrentUser(BOB);
    const ds = createDs(td.oms, "orderEntryPrices");
    const c = collector();
    await ds.subscribe({ range: RANGE }, c.callback);
    await tick();
    expect(c.size).toBe(0);
    expect(await ds.editCell?.("alice:t1", "quantity", 5)).toMatchObject({
      type: "ERROR_RESULT",
    });
    ds.unsubscribe();
  });
});
