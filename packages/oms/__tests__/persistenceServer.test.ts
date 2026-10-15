import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createExchangeSimulator, ExchangeModule } from "@heswell/exchange-sim";
import { FileStore } from "@heswell/trading-persistence/server";
import { OMS_MODULE, OrdStatus } from "@heswell/trading-schemas";
import {
  ConfigFactory,
  createVuuServerApplication,
  VuuUserWithAuthorizations,
} from "@heswell/vuu-server";
import { createOms } from "../src/engine/OmsService";
import { OmsModule } from "../src/modules/oms/OmsModule";
import { TradingRole } from "../src/permissions/access";
import { TradingPersistence } from "../src/persistence/TradingPersistence";
import { AAPL, BookSide } from "./fixture";
import { VuuClient } from "./vuuClient";

/**
 * Restart over the Vuu protocol: a trading server (EXCHANGE + OMS) persisting
 * to a FileStore is shut down and a new one recovers from the same directory;
 * a reconnecting client sees the same working order, fill and position, and
 * the restored order still trades.
 */
describe("trading server restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "trader-restart-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const startServer = async () => {
    const sim = createExchangeSimulator({
      config: {
        instruments: "AAPL.OQ,VOD.L",
        mmRate: 0,
        takerRate: 0,
        publishIntervalMs: 20,
      },
    });
    const oms = createOms(sim.gateway, {
      config: { flowRate: 0, markIntervalMs: 20, permissionMode: "strict" },
      rics: () => sim.books.map((b) => b.ric),
      log: () => {},
    });
    const persistence = new TradingPersistence({
      store: new FileStore(dir),
      sim,
      engine: oms.engine,
      log: () => {},
    });
    const recovery = persistence.recover();
    const config = ConfigFactory.fromFile(
      resolve(import.meta.dir, "../application.conf"),
      {
        env: {},
        overrides: { "vuu.websocket.port": 0, "vuu.https.port": 0 },
      },
    );
    const application = createVuuServerApplication({
      authProviders: {
        credentials: {
          allowsEmptyPassword: true,
          authenticate: async (username) =>
            VuuUserWithAuthorizations(username, [TradingRole.Execute]),
        },
      },
      config,
      defaultHttpsPort: 0,
      defaultWebSocketPort: 0,
      modules: [ExchangeModule(sim), OmsModule(oms)],
    });
    await application.lifecycle.start();
    const { server } = application;
    const token = await VuuClient.fetchToken(
      `http://localhost:${server.restPort}${config.getString("vuu.auth.path")}`,
      "alice",
    );
    const alice = await VuuClient.login(
      `ws://localhost:${server.webSocketPort}${config.getString("vuu.websocket.path")}`,
      token,
    );
    const orders = await alice.createViewport(OMS_MODULE, "parentOrders", [
      "orderId",
      "status",
      "quantity",
      "price",
      "cumQty",
      "leavesQty",
    ]);
    const positions = await alice.createViewport(OMS_MODULE, "positions", [
      "id",
      "ric",
      "quantity",
    ]);
    const fills = await alice.createViewport(OMS_MODULE, "fills", [
      "execId",
      "orderId",
      "quantity",
    ]);
    const stop = async () => {
      alice.close();
      // Main's SIGTERM handler: final snapshot, then the server stops.
      persistence.close();
      await application.lifecycle.destroy();
      oms.dispose();
    };
    return { sim, oms, recovery, alice, orders, positions, fills, stop };
  };

  test("working order, fill and position survive; the order trades on", async () => {
    const a = await startServer();
    expect(a.recovery.restored).toBe(false);
    a.sim
      .getBook(AAPL)
      ?.limit({ id: "bot1", side: BookSide.SELL, price: 170, size: 40 });
    const created = await a.alice.rpc(OMS_MODULE, a.orders, "createOrder", {
      account: "ACC-US-01",
      ric: AAPL,
      side: "BUY",
      ordType: "LIMIT",
      quantity: 100,
      price: 170,
    });
    expect(created.type).toBe("SUCCESS_RESULT");
    const order = await a.alice.row(
      a.orders,
      (r) => r.status === OrdStatus.PartiallyFilled && r.cumQty === 40,
    );
    await a.alice.row(a.positions, (r) => r.ric === AAPL && r.quantity === 40);
    await a.alice.row(a.fills, (r) => r.orderId === order.orderId);
    await a.stop();

    const b = await startServer();
    expect(b.recovery.restored).toBe(true);
    expect(b.recovery.workingOrders).toBe(1);
    expect(b.recovery.reconcile?.discrepancies).toEqual([]);
    await b.alice.row(
      b.orders,
      (r) =>
        r.orderId === order.orderId &&
        r.status === OrdStatus.PartiallyFilled &&
        r.leavesQty === 60,
    );
    await b.alice.row(b.positions, (r) => r.ric === AAPL && r.quantity === 40);
    await b.alice.row(b.fills, (r) => r.orderId === order.orderId);
    // The restored order rests in the book at the exchange and fills.
    b.sim
      .getBook(AAPL)
      ?.limit({ id: "bot2", side: BookSide.SELL, price: 170, size: 60 });
    await b.alice.row(
      b.orders,
      (r) => r.orderId === order.orderId && r.status === OrdStatus.Filled,
    );
    await b.alice.row(b.positions, (r) => r.ric === AAPL && r.quantity === 100);
    await b.stop();
  });
});
