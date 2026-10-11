import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type DataTable,
  LifecycleContainer,
  LoginTokenService,
  ModuleFactory,
  NullProvider,
  type ProviderFactory,
  VuuServer,
  VuuServerConfig,
  VuuWebSocketOptions,
} from "@heswell/vuu-server";
import {
  EXCHANGE_MODULE,
  OMS_MODULE,
  instrumentPrices,
  positionKey,
  positionPrices,
  positions,
  prices,
  toRowArray,
  toTableSchema,
} from "../src";
import {
  createExchangeTableDefs,
  createOmsTableDefs,
  toServerJoinFactory,
} from "../src/server";

describe("server adapter", () => {
  let lifecycle: LifecycleContainer;
  let server: VuuServer;

  beforeAll(async () => {
    const ex = createExchangeTableDefs();
    const oms = createOmsTableDefs();
    const nullProvider: ProviderFactory = (table) => new NullProvider(table);
    const exchangeModule = ModuleFactory.withNameSpace(EXCHANGE_MODULE)
      .addTable(ex.instruments, nullProvider)
      .addTable(ex.prices, nullProvider)
      .addTable(ex.depth, nullProvider)
      .addTable(ex.trades, nullProvider)
      .addJoinTable(toServerJoinFactory(instrumentPrices))
      .asModule();
    const omsModule = ModuleFactory.withNameSpace(OMS_MODULE)
      .addTable(oms.accounts, nullProvider)
      .addTable(oms.parentOrders, nullProvider)
      .addTable(oms.childOrders, nullProvider)
      .addTable(oms.fills, nullProvider)
      .addTable(oms.positions, nullProvider)
      .addJoinTable(toServerJoinFactory(positionPrices))
      .asModule();

    lifecycle = new LifecycleContainer();
    server = new VuuServer(
      VuuServerConfig(
        VuuWebSocketOptions().withWsPort(0).withSslDisabled(),
        {},
        LoginTokenService(),
      )
        .withModule(exchangeModule)
        .withModule(omsModule),
      lifecycle,
    );
    await lifecycle.start();
  });

  afterAll(async () => {
    await lifecycle.stop();
  });

  test("registers all tables and joins in their modules", () => {
    expect(server.tableContainer.getDefinedTables()).toEqual(
      expect.arrayContaining([
        { module: "EXCHANGE", table: "instruments" },
        { module: "EXCHANGE", table: "prices" },
        { module: "EXCHANGE", table: "depth" },
        { module: "EXCHANGE", table: "trades" },
        { module: "EXCHANGE", table: "instrumentPrices" },
        { module: "OMS", table: "accounts" },
        { module: "OMS", table: "parentOrders" },
        { module: "OMS", table: "childOrders" },
        { module: "OMS", table: "fills" },
        { module: "OMS", table: "positions" },
        { module: "OMS", table: "positionPrices" },
      ]),
    );
  });

  test("server schema matches UI TableSchema adapter", () => {
    const table = server.tableContainer.getTable<DataTable>("prices");
    expect(table.tableDef.schema).toEqual(toTableSchema(prices));
    const depth = server.tableContainer.getTable<DataTable>("depth");
    expect(depth.tableDef.links.links.map((l) => l.toTable)).toEqual([
      "prices",
      "instrumentPrices",
    ]);
  });

  test("cross-module positions x prices join ticks", () => {
    const pricesTable = server.tableContainer.getTable<DataTable>("prices");
    const positionsTable =
      server.tableContainer.getTable<DataTable>("positions");
    positionsTable.upsert(
      toRowArray(positions, {
        id: positionKey("ACC1", "VOD.L"),
        account: "ACC1",
        ric: "VOD.L",
        quantity: 100,
      }),
    );
    pricesTable.upsert(toRowArray(prices, { ric: "VOD.L", last: 101.5 }));
    const join = server.tableContainer.getTable<DataTable>("positionPrices");
    expect(join.tableDef.schema).toEqual(toTableSchema(positionPrices));
    const lastIdx = join.tableDef.columns.findIndex((c) => c.name === "last");
    expect(join.rows.length).toBe(1);
    expect(join.rows[0][lastIdx]).toBe(101.5);
  });
});
