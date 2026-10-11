import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createExchangeSimulator, ExchangeModule } from "@heswell/exchange-sim";
import {
  EXCHANGE_MODULE,
  OMS_MODULE,
  OrdStatus,
  RejectReason,
} from "@heswell/trading-schemas";
import {
  LifecycleContainer,
  LoginTokenService,
  VuuServer,
  VuuServerConfig,
  VuuUserWithAuthorizations,
  VuuWebSocketOptions,
} from "@heswell/vuu-server";
import { createOms } from "../src/engine/OmsService";
import { OmsModule } from "../src/modules/oms/OmsModule";
import { TradingRole } from "../src/permissions/access";
import { AAPL, BookSide } from "./fixture";
import { VuuClient } from "./vuuClient";

const ORDER_COLUMNS = [
  "orderId",
  "account",
  "trader",
  "ric",
  "side",
  "quantity",
  "price",
  "status",
  "cumQty",
  "leavesQty",
  "avgPx",
  "version",
  "rejectReason",
];
const FILL_COLUMNS = [
  "execId",
  "orderId",
  "account",
  "quantity",
  "price",
  "side",
];
const POSITION_COLUMNS = [
  "id",
  "account",
  "ric",
  "quantity",
  "avgCost",
  "markPx",
  "unrealizedPnl",
];

/**
 * End-to-end over the Vuu websocket protocol: EXCHANGE + OMS in one server,
 * order RPCs from OMS viewports, rows updated from exchange fills, and
 * per-user permission filtering.
 */
describe("OmsModule over the Vuu protocol", () => {
  let lifecycle: LifecycleContainer;
  let server: VuuServer;
  const sim = createExchangeSimulator({
    config: {
      instruments: "AAPL.OQ,VOD.L",
      mmRate: 0,
      takerRate: 0,
      publishIntervalMs: 20,
    },
  });
  const oms = createOms(sim.gateway, {
    config: { flowRate: 0, markIntervalMs: 20 },
    rics: () => sim.books.map((b) => b.ric),
    log: () => {},
  });
  const tokens = LoginTokenService();
  const clients: VuuClient[] = [];
  const login = async (name: string, roles: string[]) => {
    const client = await VuuClient.login(
      server.webSocketPort as number,
      tokens.getToken(VuuUserWithAuthorizations(name, roles)),
    );
    clients.push(client);
    return client;
  };
  const rest = (side: BookSide, price: number, size: number) =>
    sim.getBook(AAPL)?.limit({
      id: `bot-${price}-${size}-${Math.random()}`,
      side,
      price,
      size,
    });

  let alice: VuuClient;
  let bob: VuuClient;
  let sam: VuuClient;
  let aliceOrders: string;
  let bobOrders: string;
  let samOrders: string;

  beforeAll(async () => {
    lifecycle = new LifecycleContainer();
    server = new VuuServer(
      VuuServerConfig(
        VuuWebSocketOptions().withWsPort(0).withSslDisabled(),
        {},
        tokens,
      )
        .withModule(ExchangeModule(sim))
        .withModule(OmsModule(oms)),
      lifecycle,
    );
    await lifecycle.start();
    alice = await login("alice", [TradingRole.Execute]);
    bob = await login("bob", [TradingRole.Execute]);
    sam = await login("sam", [TradingRole.Supervisor]);
    aliceOrders = await alice.createViewport(
      OMS_MODULE,
      "parentOrders",
      ORDER_COLUMNS,
    );
    bobOrders = await bob.createViewport(
      OMS_MODULE,
      "parentOrders",
      ORDER_COLUMNS,
    );
    samOrders = await sam.createViewport(
      OMS_MODULE,
      "parentOrders",
      ORDER_COLUMNS,
    );
  });

  afterAll(async () => {
    for (const client of clients) client.close();
    await lifecycle?.destroy();
    expect(oms.running).toBe(false);
    oms.dispose();
  });

  test("module starts the OMS once its tables are loaded; accounts are seeded", async () => {
    expect(oms.running).toBe(true);
    expect([...oms.tables.attached].sort() as string[]).toEqual(
      ["accounts", "childOrders", "fills", "parentOrders", "positions"].sort(),
    );
    const vp = await sam.createViewport(OMS_MODULE, "accounts", [
      "account",
      "owner",
      "desk",
      "enabled",
    ]);
    await sam.row(
      vp,
      (r) => r.account === "ACC-ASIA-03" && r.enabled === false,
    );
    expect(sam.rowsOf(vp)).toHaveLength(7);
  });

  test("createOrder RPC -> exchange fill -> parentOrders, fills, positions rows", async () => {
    rest(BookSide.SELL, 170, 100);
    const fills = await alice.createViewport(OMS_MODULE, "fills", FILL_COLUMNS);
    const positions = await alice.createViewport(
      OMS_MODULE,
      "positions",
      POSITION_COLUMNS,
    );
    const result = await alice.rpc(OMS_MODULE, aliceOrders, "createOrder", {
      account: "ACC-US-01",
      ric: AAPL,
      side: "BUY",
      ordType: "LIMIT",
      quantity: 60,
      price: 170,
      clOrdId: "ui-1",
    });
    // read before toMatchObject: bun mutates the received object with asymmetric matchers
    const orderId = result.data?.orderId;
    expect(result).toMatchObject({
      type: "SUCCESS_RESULT",
      data: {
        orderId: expect.stringMatching(/^O-\d+$/),
        clOrdId: "ui-1",
        status: OrdStatus.Filled,
      },
    });
    expect(
      await alice.row(
        aliceOrders,
        (r) => r.orderId === orderId && r.status === OrdStatus.Filled,
      ),
    ).toMatchObject({
      account: "ACC-US-01",
      trader: "alice",
      cumQty: 60,
      leavesQty: 0,
      avgPx: 170,
    });
    expect(await alice.row(fills, (r) => r.orderId === orderId)).toMatchObject({
      quantity: 60,
      price: 170,
      side: "BUY",
    });
    expect(
      await alice.row(
        positions,
        (r) => r.id === "ACC-US-01|AAPL.OQ" && r.quantity === 60,
      ),
    ).toMatchObject({ avgCost: 170, markPx: 170 });
  });

  test("positionPrices join carries market data and the OMS RPCs", async () => {
    const vp = await alice.createViewport(OMS_MODULE, "positionPrices", [
      "id",
      "account",
      "quantity",
      "last",
      "phase",
    ]);
    expect(
      await alice.row(
        vp,
        (r) => r.id === "ACC-US-01|AAPL.OQ" && r.last === 170,
      ),
    ).toMatchObject({ quantity: 60, phase: "CONTINUOUS" });
    // RPCs work from the join viewport too
    const result = await alice.rpc(OMS_MODULE, vp, "createOrder", {
      account: "ACC-US-01",
      ric: AAPL,
      side: "BUY",
      ordType: "LIMIT",
      quantity: 5,
      price: 160,
    });
    expect(result.type).toBe("SUCCESS_RESULT");
    expect(
      await alice.rpc(OMS_MODULE, vp, "cancelOrder", {
        orderId: result.data?.orderId,
      }),
    ).toMatchObject({
      type: "SUCCESS_RESULT",
      data: { status: OrdStatus.Cancelled },
    });
  });

  test("amend and cancel RPCs, with contract errors", async () => {
    const created = await alice.rpc(OMS_MODULE, aliceOrders, "createOrder", {
      account: "ACC-US-01",
      ric: AAPL,
      side: "BUY",
      ordType: "LIMIT",
      quantity: 100,
      price: 165,
    });
    const orderId = created.data?.orderId;
    expect(
      await alice.rpc(OMS_MODULE, aliceOrders, "amendOrder", {
        orderId,
        price: 165.5,
        quantity: 120,
      }),
    ).toEqual({
      type: "SUCCESS_RESULT",
      data: { orderId, status: OrdStatus.Replaced },
    });
    await alice.row(
      aliceOrders,
      (r) =>
        r.orderId === orderId &&
        r.version === 1 &&
        r.price === 165.5 &&
        r.quantity === 120,
    );
    expect(
      await alice.rpc(OMS_MODULE, aliceOrders, "amendOrder", { orderId }),
    ).toMatchObject({
      type: "ERROR_RESULT",
      errorMessage: expect.stringMatching(/^INVALID_REQUEST/),
    });
    expect(
      await alice.rpc(OMS_MODULE, aliceOrders, "cancelOrder", { orderId }),
    ).toEqual({
      type: "SUCCESS_RESULT",
      data: { orderId, status: OrdStatus.Cancelled },
    });
    expect(
      await alice.rpc(OMS_MODULE, aliceOrders, "cancelOrder", { orderId }),
    ).toMatchObject({
      type: "ERROR_RESULT",
      errorMessage: expect.stringMatching(/^TOO_LATE_TO_CANCEL/),
    });
  });

  test("risk rejects return ERROR_RESULT and show as REJECTED rows", async () => {
    const result = await alice.rpc(OMS_MODULE, aliceOrders, "createOrder", {
      account: "ACC-US-01",
      ric: AAPL,
      side: "BUY",
      ordType: "LIMIT",
      quantity: 60_000,
      price: 170,
    });
    expect(result).toMatchObject({
      type: "ERROR_RESULT",
      errorMessage: expect.stringMatching(/^EXCEEDS_MAX_QUANTITY: /),
    });
    await alice.row(
      aliceOrders,
      (r) =>
        r.status === OrdStatus.Rejected &&
        r.rejectReason === RejectReason.ExceedsMaxQuantity &&
        r.quantity === 60_000,
    );
  });

  test("permission filter: traders see own accounts, supervisor sees all", async () => {
    const created = await bob.rpc(OMS_MODULE, bobOrders, "createOrder", {
      account: "ACC-US-02",
      ric: AAPL,
      side: "SELL",
      ordType: "LIMIT",
      quantity: 10,
      price: 175,
    });
    expect(created.type).toBe("SUCCESS_RESULT");
    const bobsId = created.data?.orderId;
    await bob.row(bobOrders, (r) => r.orderId === bobsId);
    await sam.row(samOrders, (r) => r.orderId === bobsId);
    await sam.row(samOrders, (r) => r.account === "ACC-US-01");
    expect(bob.rowsOf(bobOrders).every((r) => r.account === "ACC-US-02")).toBe(
      true,
    );
    expect(
      alice.rowsOf(aliceOrders).every((r) => r.account === "ACC-US-01"),
    ).toBe(true);

    // bob cannot trade or see alice's account; sam (no trading-execute) cannot trade
    expect(
      await bob.rpc(OMS_MODULE, bobOrders, "createOrder", {
        account: "ACC-US-01",
        ric: AAPL,
        side: "BUY",
        ordType: "LIMIT",
        quantity: 1,
        price: 170,
      }),
    ).toMatchObject({
      errorMessage: expect.stringMatching(/^PERMISSION_DENIED/),
    });
    const alicesId = alice.rowsOf(aliceOrders)[0]?.orderId;
    expect(
      await bob.rpc(OMS_MODULE, bobOrders, "cancelOrder", {
        orderId: alicesId,
      }),
    ).toMatchObject({ errorMessage: expect.stringMatching(/^UNKNOWN_ORDER/) });
    expect(
      await sam.rpc(OMS_MODULE, samOrders, "cancelOrder", { orderId: bobsId }),
    ).toMatchObject({
      errorMessage: expect.stringMatching(/^PERMISSION_DENIED/),
    });
    expect(await bob.rpc(OMS_MODULE, bobOrders, "cancelAll", {})).toEqual({
      type: "SUCCESS_RESULT",
      data: { orderIds: [bobsId] },
    });
  });

  test("invalid params are INVALID_REQUEST", async () => {
    expect(
      await alice.rpc(OMS_MODULE, aliceOrders, "createOrder", {
        account: "ACC-US-01",
      }),
    ).toMatchObject({
      type: "ERROR_RESULT",
      errorMessage: expect.stringMatching(/^INVALID_REQUEST/),
    });
  });

  test("blotter edit session: save amends / cancels through the OMS", async () => {
    const make = async (price: number) =>
      (
        await alice.rpc(OMS_MODULE, aliceOrders, "createOrder", {
          account: "ACC-US-01",
          ric: AAPL,
          side: "BUY",
          ordType: "LIMIT",
          quantity: 10,
          price,
        })
      ).data?.orderId as string;
    const toAmend = await make(161);
    const toCancel = await make(162);
    await alice.row(aliceOrders, (r) => r.orderId === toCancel);

    // edits are refused outside a session
    expect(
      await alice.rpc(OMS_MODULE, aliceOrders, "editCell", {
        key: toAmend,
        column: "price",
        data: 1,
      }),
    ).toMatchObject({ type: "ERROR_RESULT" });

    const begun = await alice.rpc(
      OMS_MODULE,
      aliceOrders,
      "beginEditSession",
      {},
    );
    expect(begun.type).toBe("SUCCESS_RESULT");
    const sessionTable = begun.data?.sessionTable as string;
    const session = await alice.createViewport(
      OMS_MODULE,
      sessionTable,
      ORDER_COLUMNS,
    );
    // the session copy is permission filtered too
    await alice.row(session, (r) => r.orderId === toAmend);
    expect(alice.rowsOf(session).every((r) => r.account === "ACC-US-01")).toBe(
      true,
    );

    expect(
      await alice.rpc(OMS_MODULE, session, "editCell", {
        key: toAmend,
        column: "side",
        data: "SELL",
      }),
    ).toMatchObject({ errorMessage: expect.stringMatching(/not editable/) });
    expect(
      await alice.rpc(OMS_MODULE, session, "addRow", { key: "x", data: {} }),
    ).toMatchObject({ type: "ERROR_RESULT" });
    expect(
      await alice.rpc(OMS_MODULE, session, "editCell", {
        key: toAmend,
        column: "price",
        data: 161.5,
      }),
    ).toMatchObject({ type: "SUCCESS_RESULT" });
    expect(
      await alice.rpc(OMS_MODULE, session, "deleteRow", { key: toCancel }),
    ).toMatchObject({ type: "SUCCESS_RESULT" });

    const saved = await alice.rpc(OMS_MODULE, session, "endEditSession", {
      save: true,
    });
    expect(saved).toMatchObject({ type: "SUCCESS_RESULT" });
    expect(saved.data?.results).toEqual(
      expect.arrayContaining([
        { orderId: toAmend, action: "amendOrder", status: OrdStatus.Replaced },
        {
          orderId: toCancel,
          action: "cancelOrder",
          status: OrdStatus.Cancelled,
        },
      ]),
    );
    expect(oms.engine.getOrder(toAmend)?.state).toMatchObject({
      price: 161.5,
      version: 1,
    });
    expect(oms.engine.getOrder(toCancel)?.state.status).toBe(
      OrdStatus.Cancelled,
    );
  });

  test("EXCHANGE and OMS modules coexist", async () => {
    const vp = await alice.createViewport(EXCHANGE_MODULE, "prices", [
      "ric",
      "last",
    ]);
    await alice.row(vp, (r) => r.ric === AAPL && r.last === 170);
  });
});
