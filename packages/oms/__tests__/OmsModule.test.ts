import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { createExchangeSimulator, ExchangeModule } from "@heswell/exchange-sim";
import {
  EXCHANGE_MODULE,
  OMS_MODULE,
  OrdStatus,
  RejectReason,
} from "@heswell/trading-schemas";
import {
  ConfigFactory,
  createVuuServerApplication,
  type VuuServer,
  type VuuServerApplication,
  VuuUserWithAuthorizations,
} from "@heswell/vuu-server";
import { createOms } from "../src/engine/OmsService";
import { OmsNotificationModule } from "../src/modules/notifications/OmsNotificationModule";
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
const SESSION_COLUMNS = [...ORDER_COLUMNS, "vuuMsg"];
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
  let application: VuuServerApplication;
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
    // strict: a user without trading roles sees nothing (eve below)
    config: {
      flowRate: 0,
      markIntervalMs: 20,
      pnlHistoryIntervalMs: 40,
      permissionMode: "strict",
    },
    rics: () => sim.books.map((b) => b.ric),
    log: () => {},
  });
  // Stand-alone OMS config (permissive auth over plain HTTP) on ephemeral
  // ports. Permissive auth grants no roles, so the test's credential provider
  // assigns them; the token still comes from POST /api/authn.
  const config = ConfigFactory.fromFile(
    resolve(import.meta.dir, "../application.conf"),
    {
      env: {},
      overrides: { "vuu.websocket.port": 0, "vuu.https.port": 0 },
    },
  );
  const roles: Record<string, string[]> = {
    alice: [TradingRole.Execute],
    bob: [TradingRole.Execute],
    sam: [TradingRole.Supervisor],
  };
  const clients: VuuClient[] = [];
  const login = async (name: string) => {
    const token = await VuuClient.fetchToken(
      `http://localhost:${server.restPort}${config.getString("vuu.auth.path")}`,
      name,
    );
    const client = await VuuClient.login(
      `ws://localhost:${server.webSocketPort}${config.getString("vuu.websocket.path")}`,
      token,
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
    application = createVuuServerApplication({
      authProviders: {
        credentials: {
          // like permissive auth: logins send no password
          allowsEmptyPassword: true,
          authenticate: async (username) =>
            VuuUserWithAuthorizations(username, roles[username] ?? []),
        },
      },
      config,
      defaultHttpsPort: 0,
      defaultWebSocketPort: 0,
      modules: [
        ExchangeModule(sim),
        OmsModule(oms),
        OmsNotificationModule(oms),
      ],
    });
    await application.lifecycle.start();
    server = application.server;
    expect(server.restUrl).toStartWith("http://");
    alice = await login("alice");
    bob = await login("bob");
    sam = await login("sam");
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
    await application?.lifecycle.destroy();
    expect(oms.running).toBe(false);
    oms.dispose();
  });

  test("module starts the OMS once its tables are loaded; accounts are seeded", async () => {
    expect(oms.running).toBe(true);
    expect([...oms.tables.attached].sort() as string[]).toEqual(
      [
        "accounts",
        "childOrders",
        "fills",
        "parentOrders",
        "positions",
        "pnlHistory",
        "accountPnlHistory",
      ].sort(),
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

  test("pnlHistory / accountPnlHistory are permission filtered like positions", async () => {
    const columns = ["id", "account", "ric", "time", "quantity", "markPx"];
    const accountColumns = [
      "id",
      "account",
      "time",
      "positions",
      "netExposure",
    ];
    const aliceHistory = await alice.createViewport(
      OMS_MODULE,
      "pnlHistory",
      columns,
    );
    const bobHistory = await bob.createViewport(
      OMS_MODULE,
      "pnlHistory",
      columns,
    );
    const samTotals = await sam.createViewport(
      OMS_MODULE,
      "accountPnlHistory",
      accountColumns,
    );
    const bobTotals = await bob.createViewport(
      OMS_MODULE,
      "accountPnlHistory",
      accountColumns,
    );
    expect(
      await alice.row(
        aliceHistory,
        (r) => r.account === "ACC-US-01" && r.ric === AAPL,
      ),
    ).toMatchObject({ quantity: 60, markPx: 170 });
    expect(
      await sam.row(samTotals, (r) => r.account === "ACC-US-01"),
    ).toMatchObject({ positions: 1, netExposure: 60 * 170 });
    // a few more samples: bob (ACC-US-02 only, no position) sees nothing
    await Bun.sleep(150);
    expect(bob.rowsOf(bobHistory)).toEqual([]);
    expect(bob.rowsOf(bobTotals)).toEqual([]);
    expect(
      alice.rowsOf(aliceHistory).every((r) => r.account === "ACC-US-01"),
    ).toBe(true);
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

  test("positionPrices join is permission filtered per viewport user", async () => {
    // bob takes 10 of the 40 still resting at 170 for his own account
    const bought = await bob.rpc(OMS_MODULE, bobOrders, "createOrder", {
      account: "ACC-US-02",
      ric: AAPL,
      side: "BUY",
      ordType: "LIMIT",
      quantity: 10,
      price: 170,
    });
    expect(bought).toMatchObject({
      type: "SUCCESS_RESULT",
      data: { status: OrdStatus.Filled },
    });
    const columns = ["id", "account", "quantity", "last"];
    const aliceVp = await alice.createViewport(
      OMS_MODULE,
      "positionPrices",
      columns,
    );
    const bobVp = await bob.createViewport(
      OMS_MODULE,
      "positionPrices",
      columns,
    );
    const samVp = await sam.createViewport(
      OMS_MODULE,
      "positionPrices",
      columns,
    );
    await alice.row(aliceVp, (r) => r.id === "ACC-US-01|AAPL.OQ");
    await bob.row(bobVp, (r) => r.id === "ACC-US-02|AAPL.OQ");
    await sam.row(samVp, (r) => r.id === "ACC-US-01|AAPL.OQ");
    await sam.row(samVp, (r) => r.id === "ACC-US-02|AAPL.OQ");
    expect(alice.rowsOf(aliceVp).every((r) => r.account === "ACC-US-01")).toBe(
      true,
    );
    expect(bob.rowsOf(bobVp).every((r) => r.account === "ACC-US-02")).toBe(
      true,
    );
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

  test("rejects publish topic-tagged rows to NOTIFICATIONS, filtered by account", async () => {
    const columns = [
      "id",
      "type",
      "level",
      "topic",
      "title",
      "audience",
      "account",
      "orderId",
    ];
    const aliceNotes = await alice.createViewport(
      "NOTIFICATIONS",
      "notifications",
      columns,
    );
    const bobNotes = await bob.createViewport(
      "NOTIFICATIONS",
      "notifications",
      columns,
    );
    await alice.rpc(OMS_MODULE, aliceOrders, "createOrder", {
      account: "ACC-US-01",
      ric: AAPL,
      side: "SELL",
      ordType: "LIMIT",
      quantity: 70_000,
      price: 170,
    });
    const note = await alice.row(
      aliceNotes,
      (r) => r.topic === "orders" && String(r.title).includes("SELL 70000"),
    );
    expect(note).toMatchObject({
      type: "silent",
      level: "ERROR",
      audience: "alice",
      account: "ACC-US-01",
    });
    await Bun.sleep(100);
    expect(
      bob.rowsOf(bobNotes).filter((r) => r.account === "ACC-US-01"),
    ).toEqual([]);
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

  test("blotter edit session: stale rows fail unless forced", async () => {
    const orderId = (
      await alice.rpc(OMS_MODULE, aliceOrders, "createOrder", {
        account: "ACC-US-01",
        ric: AAPL,
        side: "BUY",
        ordType: "LIMIT",
        quantity: 10,
        price: 163,
      })
    ).data?.orderId as string;
    await alice.row(aliceOrders, (r) => r.orderId === orderId);
    const begun = await alice.rpc(
      OMS_MODULE,
      aliceOrders,
      "beginEditSession",
      {},
    );
    const session = await alice.createViewport(
      OMS_MODULE,
      begun.data?.sessionTable as string,
      SESSION_COLUMNS,
    );
    await alice.row(session, (r) => r.orderId === orderId);
    expect(
      await alice.rpc(OMS_MODULE, session, "editCell", {
        key: orderId,
        column: "quantity",
        data: 15,
      }),
    ).toMatchObject({ type: "SUCCESS_RESULT" });

    // the order changes underneath the session (another viewport amends it)
    expect(
      await alice.rpc(OMS_MODULE, aliceOrders, "amendOrder", {
        orderId,
        price: 163.5,
      }),
    ).toMatchObject({ type: "SUCCESS_RESULT" });
    await alice.row(
      aliceOrders,
      (r) => r.orderId === orderId && r.version === 1,
    );

    expect(
      await alice.rpc(OMS_MODULE, session, "endEditSession", { save: true }),
    ).toEqual({ type: "ERROR_RESULT", errorMessage: "stale update" });
    expect(oms.engine.getOrder(orderId)?.state.quantity).toBe(10);
    // the session stays open; the row says which columns moved
    const staleRow = await alice.row(
      session,
      (r) => r.orderId === orderId && String(r.vuuMsg).includes("stale:"),
    );
    expect(String(staleRow.vuuMsg)).toMatch(
      new RegExp(`stale:${orderId}:(\\w+\\|)*version`),
    );

    expect(
      await alice.rpc(OMS_MODULE, session, "endEditSession", {
        save: true,
        force: true,
      }),
    ).toMatchObject({
      type: "SUCCESS_RESULT",
      data: {
        results: [
          { orderId, action: "amendOrder", status: OrdStatus.Replaced },
        ],
      },
    });
    expect(oms.engine.getOrder(orderId)?.state).toMatchObject({
      quantity: 15,
      version: 2,
    });
  });

  const limitOrder = async (client: VuuClient, vp: string, price: number) => {
    const created = await client.rpc(OMS_MODULE, vp, "createOrder", {
      account: client === bob ? "ACC-US-02" : "ACC-US-01",
      ric: AAPL,
      side: "BUY",
      ordType: "LIMIT",
      quantity: 10,
      price,
    });
    expect(created.type).toBe("SUCCESS_RESULT");
    const orderId = created.data?.orderId as string;
    await client.row(vp, (r) => r.orderId === orderId);
    return orderId;
  };
  const beginSession = async (client: VuuClient, vp: string) => {
    const begun = await client.rpc(OMS_MODULE, vp, "beginEditSession", {});
    expect(begun.type).toBe("SUCCESS_RESULT");
    return client.createViewport(
      OMS_MODULE,
      begun.data?.sessionTable as string,
      SESSION_COLUMNS,
    );
  };

  test("blotter edit session: order validation on edit, OMS rejects keep the session open", async () => {
    const orderId = await limitOrder(alice, aliceOrders, 164);
    const session = await beginSession(alice, aliceOrders);
    await alice.row(session, (r) => r.orderId === orderId);
    const edit = (column: string, data: unknown) =>
      alice.rpc(OMS_MODULE, session, "editCell", {
        key: orderId,
        column,
        data,
      });

    // key, system and other columns are refused, values are type checked
    expect(await edit("orderId", "x")).toMatchObject({
      errorMessage: expect.stringMatching(/not editable/),
    });
    expect(await edit("vuuMsg", "x")).toMatchObject({
      errorMessage: expect.stringMatching(/not editable/),
    });
    expect(await edit("quantity", "lots")).toMatchObject({
      errorMessage: expect.stringMatching(/invalid value/),
    });
    // amend validation (validateCellEdit)
    expect(await edit("price", -1)).toMatchObject({
      errorMessage: expect.stringMatching(/^INVALID_PRICE/),
    });
    expect(await edit("quantity", 0)).toMatchObject({
      errorMessage: expect.stringMatching(/^INVALID_QUANTITY/),
    });
    expect(await edit("quantity", "12")).toMatchObject({
      type: "SUCCESS_RESULT",
    });

    // a risk reject at save fails it (upstream issue 18) and keeps the session
    expect(await edit("quantity", 60_000)).toMatchObject({
      type: "SUCCESS_RESULT",
    });
    expect(
      await alice.rpc(OMS_MODULE, session, "endEditSession", { save: true }),
    ).toMatchObject({
      type: "ERROR_RESULT",
      errorMessage: expect.stringMatching(
        new RegExp(`^${orderId}: ${RejectReason.ExceedsMaxQuantity}`),
      ),
    });
    expect(oms.engine.getOrder(orderId)?.state.quantity).toBe(10);
    expect(await edit("quantity", 20)).toMatchObject({
      type: "SUCCESS_RESULT",
    });
    expect(
      await alice.rpc(OMS_MODULE, session, "endEditSession", { save: true }),
    ).toMatchObject({ type: "SUCCESS_RESULT" });
    expect(oms.engine.getOrder(orderId)?.state.quantity).toBe(20);
  });

  test("blotter edit session: hidden rows, other sessions and other tables are refused", async () => {
    const bobsId = await limitOrder(bob, bobOrders, 166);
    const alicesId = await limitOrder(alice, aliceOrders, 166);
    const session = await beginSession(alice, aliceOrders);
    await alice.row(session, (r) => r.orderId === alicesId);
    // bob's order was not copied, and cannot be edited or deleted
    expect(alice.rowsOf(session).some((r) => r.orderId === bobsId)).toBe(false);
    expect(
      await alice.rpc(OMS_MODULE, session, "editCell", {
        key: bobsId,
        column: "price",
        data: 1,
      }),
    ).toMatchObject({ errorMessage: expect.stringMatching(/not found/) });
    expect(
      await alice.rpc(OMS_MODULE, session, "deleteRow", { key: bobsId }),
    ).toMatchObject({ errorMessage: expect.stringMatching(/not found/) });

    // bob cannot drive alice's session viewport
    const notFound = { errorMessage: `viewport not found ${session}` };
    expect(
      await bob.rpc(OMS_MODULE, session, "deleteRow", { key: alicesId }),
    ).toMatchObject(notFound);
    expect(
      await bob.rpc(OMS_MODULE, session, "endEditSession", { save: true }),
    ).toMatchObject(notFound);

    // no session of a session, no sessions on other OMS tables
    expect(
      await alice.rpc(OMS_MODULE, session, "beginEditSession", {}),
    ).toMatchObject({ type: "ERROR_RESULT" });
    const fills = await alice.createViewport(OMS_MODULE, "fills", FILL_COLUMNS);
    expect(
      await alice.rpc(OMS_MODULE, fills, "beginEditSession", {}),
    ).toMatchObject({
      errorMessage:
        "beginEditSession: only parentOrders supports edit sessions",
    });

    expect(
      await alice.rpc(OMS_MODULE, session, "endEditSession", { save: false }),
    ).toMatchObject({ type: "SUCCESS_RESULT" });
    expect(oms.engine.getOrder(bobsId)?.state.status).toBe(OrdStatus.New);
  });

  test("blotter edit session: strict mode, and users without trading-execute cannot save", async () => {
    const orderId = await limitOrder(alice, aliceOrders, 167);
    const eve = await login("eve");
    const eveOrders = await eve.createViewport(
      OMS_MODULE,
      "parentOrders",
      ORDER_COLUMNS,
    );
    const eveSession = await beginSession(eve, eveOrders);
    // strict: no roles, no rows
    await Bun.sleep(100);
    expect(eve.rowsOf(eveOrders)).toEqual([]);
    expect(eve.rowsOf(eveSession)).toEqual([]);
    expect(
      await eve.rpc(OMS_MODULE, eveSession, "deleteRow", { key: orderId }),
    ).toMatchObject({ errorMessage: expect.stringMatching(/not found/) });

    // a supervisor without trading-execute sees the order and may edit the
    // session, but canSaveSession refuses the save
    const samSession = await beginSession(sam, samOrders);
    await sam.row(samSession, (r) => r.orderId === orderId);
    expect(
      await sam.rpc(OMS_MODULE, samSession, "deleteRow", { key: orderId }),
    ).toMatchObject({ type: "SUCCESS_RESULT" });
    expect(
      await sam.rpc(OMS_MODULE, samSession, "endEditSession", { save: true }),
    ).toEqual({
      type: "ERROR_RESULT",
      errorMessage: `${RejectReason.PermissionDenied}: sam may not trade`,
    });
    expect(oms.engine.getOrder(orderId)?.state.status).toBe(OrdStatus.New);
  });

  test("EXCHANGE and OMS modules coexist", async () => {
    const vp = await alice.createViewport(EXCHANGE_MODULE, "prices", [
      "ric",
      "last",
    ]);
    await alice.row(vp, (r) => r.ric === AAPL && r.last === 170);
    const bars = await alice.createViewport(EXCHANGE_MODULE, "bars", [
      "id",
      "ric",
      "interval",
      "close",
      "volume",
      "backfilled",
    ]);
    // the live fill at 170 (backfilled history is also present)
    expect(
      await alice.row(
        bars,
        (r) => r.ric === AAPL && r.interval === "1m" && r.backfilled === false,
      ),
    ).toMatchObject({ close: 170 });
  });

  test("session limit: a user may hold five tabs; a sixth is refused (4003) until one closes", async () => {
    expect(config.getNumber("vuu.server.maxSessionsPerUser")).toBe(5);
    expect(config.getString("vuu.server.sessionLimitPolicy")).toBe(
      "reject-new",
    );
    const tabs: VuuClient[] = [];
    for (let i = 0; i < 5; i++) tabs.push(await login("tabby"));
    await expect(login("tabby")).rejects.toThrow(/^login closed 4003: /);
    for (const tab of tabs) {
      const vp = await tab.createViewport(EXCHANGE_MODULE, "prices", ["ric"]);
      await tab.row(vp, (r) => r.ric === AAPL);
    }
    tabs[0].close();
    await Bun.sleep(100);
    const sixth = await login("tabby");
    const vp = await sixth.createViewport(EXCHANGE_MODULE, "prices", ["ric"]);
    await sixth.row(vp, (r) => r.ric === AAPL);
  });
});
