import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  EXCHANGE_MODULE,
  RejectReason,
  TradingPhase,
} from "@heswell/trading-schemas";
import {
  LifecycleContainer,
  LoginTokenService,
  VuuServer,
  VuuServerConfig,
  VuuUserWithAuthorizations,
  VuuWebSocketOptions,
} from "@heswell/vuu-server";
import type {
  ServerToClientTableRows,
  VuuRpcServiceResponse,
  VuuServerMessage,
  VuuViewportCreateSuccessResponse,
} from "@vuu-ui/vuu-protocol-types";
import { createExchangeSimulator } from "../src/engine/ExchangeSimulator";
import { ExchangeModule } from "../src/modules/exchange/ExchangeModule";

/**
 * End-to-end over the Vuu websocket protocol: the module registers the
 * EXCHANGE tables, the simulator ticks on real timers, a client subscribes
 * and invokes admin RPCs.
 */
describe("ExchangeModule over the Vuu protocol", () => {
  let lifecycle: LifecycleContainer;
  let server: VuuServer;
  let socket: WebSocket;
  let sessionId: string;
  const sim = createExchangeSimulator({
    config: { activeInstruments: 10, botStepMs: 10, publishIntervalMs: 50 },
  });
  let requestId = 0;

  const send = (body: Record<string, unknown>) =>
    socket.send(
      JSON.stringify({
        body,
        module: EXCHANGE_MODULE,
        requestId: `r${++requestId}`,
        sessionId,
      }),
    );

  const createViewport = async (table: string, columns: string[]) => {
    const created = waitFor<VuuViewportCreateSuccessResponse>(
      socket,
      (body): body is VuuViewportCreateSuccessResponse =>
        body.type === "CREATE_VP_SUCCESS" &&
        (body as VuuViewportCreateSuccessResponse).table === table,
    );
    send({
      aggregations: [],
      columns,
      filterSpec: { filter: "" },
      groupBy: [],
      range: { from: 0, to: 100 },
      sort: { sortDefs: [] },
      table: { module: EXCHANGE_MODULE, table },
      type: "CREATE_VP",
    });
    return (await created).viewPortId;
  };

  /** Collect TABLE_ROW updates for a viewport for `ms`. */
  const collectRows = (viewPortId: string, ms: number) =>
    new Promise<ServerToClientTableRows["rows"]>((resolve) => {
      const rows: ServerToClientTableRows["rows"] = [];
      const listener = ({ data }: MessageEvent) => {
        const message = JSON.parse(String(data)) as VuuServerMessage;
        if (message.body.type === "TABLE_ROW") {
          for (const row of message.body.rows) {
            if (row.viewPortId === viewPortId && row.updateType === "U") {
              rows.push(row);
            }
          }
        }
      };
      socket.addEventListener("message", listener);
      setTimeout(() => {
        socket.removeEventListener("message", listener);
        resolve(rows);
      }, ms);
    });

  const rpc = async (
    viewPortId: string,
    rpcName: string,
    params: Record<string, unknown>,
  ) => {
    const response = waitFor<VuuRpcServiceResponse>(
      socket,
      (body): body is VuuRpcServiceResponse =>
        body.type === "RPC_RESPONSE" && (body.rpcName as string) === rpcName,
    );
    send({
      context: { type: "VIEWPORT_CONTEXT", viewPortId },
      params,
      rpcName,
      type: "RPC_REQUEST",
    });
    return (await response).result;
  };

  beforeAll(async () => {
    lifecycle = new LifecycleContainer();
    const loginTokenService = LoginTokenService();
    server = new VuuServer(
      VuuServerConfig(
        VuuWebSocketOptions().withWsPort(0).withSslDisabled(),
        {},
        loginTokenService,
      ).withModule(ExchangeModule(sim)),
      lifecycle,
    );
    await lifecycle.start();
    const token = loginTokenService.getToken(
      VuuUserWithAuthorizations("trader1", []),
    );
    ({ socket, sessionId } = await login(
      server.webSocketPort as number,
      token,
    ));
  });

  afterAll(async () => {
    socket?.close();
    await lifecycle?.destroy();
    expect(sim.running).toBe(false);
  });

  test("tables are registered and the simulator is running", () => {
    expect(sim.running).toBe(true);
    for (const name of [
      "instruments",
      "prices",
      "depth",
      "trades",
      "instrumentPrices",
    ]) {
      expect(server.tableContainer.getTable(name)).toBeDefined();
    }
    expect(server.tableContainer.getTable("instruments").rowCount).toBe(
      sim.universe.length,
    );
  });

  test("prices, depth and trades tick over the websocket", async () => {
    const pricesVp = await createViewport("prices", [
      "ric",
      "bid",
      "ask",
      "last",
      "phase",
      "seq",
    ]);
    const depthVp = await createViewport("depth", [
      "id",
      "ric",
      "side",
      "level",
      "price",
      "size",
    ]);
    const tradesVp = await createViewport("trades", [
      "tradeId",
      "ric",
      "price",
      "size",
    ]);
    const [prices, depth, trades] = await Promise.all([
      collectRows(pricesVp, 1_500),
      collectRows(depthVp, 1_500),
      collectRows(tradesVp, 1_500),
    ]);
    expect(prices.length).toBeGreaterThan(10);
    expect(depth.length).toBeGreaterThan(10);
    expect(trades.length).toBeGreaterThan(0);
    const ticking = prices.filter(({ data }) =>
      sim.isSimulated(String(data[0])),
    );
    expect(ticking.length).toBeGreaterThan(0);
    const [, bid, ask, , phase] = ticking[ticking.length - 1].data;
    expect(Number(ask)).toBeGreaterThan(Number(bid));
    expect(phase).toBe(TradingPhase.Continuous);
  });

  test("instrumentPrices join carries the admin RPC service", async () => {
    const vp = await createViewport("instrumentPrices", [
      "ric",
      "description",
      "currency",
      "bid",
      "ask",
      "phase",
    ]);
    const rows = await collectRows(vp, 500);
    expect(rows.length).toBeGreaterThan(0);
    const ric = sim.books[0].ric;
    expect(await rpc(vp, "haltInstrument", { ric, reason: "test" })).toEqual({
      type: "SUCCESS_RESULT",
      data: { rics: [ric] },
    });
    expect(sim.getBook(ric)?.phase).toBe(TradingPhase.Halted);
    expect(await rpc(vp, "resumeInstrument", { ric })).toEqual({
      type: "SUCCESS_RESULT",
      data: { rics: [ric] },
    });
  });

  test("admin RPCs on a base table, with contract errors", async () => {
    const vp = await createViewport("prices", ["ric", "phase"]);
    expect(await rpc(vp, "setVolatility", { volatility: 0.5 })).toMatchObject({
      type: "SUCCESS_RESULT",
    });
    expect(sim.books.every(({ model }) => model.volatility === 0.5)).toBe(true);
    expect(
      await rpc(vp, "setBotRate", { bot: "TAKER", rate: 0 }),
    ).toMatchObject({ type: "SUCCESS_RESULT" });
    expect(sim.getSimulated(sim.books[0].ric)?.takerRate).toBe(0);
    expect(await rpc(vp, "haltInstrument", { ric: "NOPE.X" })).toEqual({
      type: "ERROR_RESULT",
      errorMessage: `${RejectReason.UnknownInstrument}: unknown instrument NOPE.X`,
    });
    expect(await rpc(vp, "setVolatility", {})).toMatchObject({
      type: "ERROR_RESULT",
      errorMessage: expect.stringMatching(/^INVALID_REQUEST/),
    });
  });
});

async function login(
  port: number,
  token: string,
): Promise<{ socket: WebSocket; sessionId: string }> {
  const socket = new WebSocket(`ws://localhost:${port}/websocket`);
  const loggedIn = waitFor<string>(
    socket,
    (body) => body.type === "LOGIN_SUCCESS",
    true,
  );
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () => reject(Error("WebSocket failed")));
  });
  socket.send(
    JSON.stringify({
      body: { token, type: "LOGIN" },
      module: "CORE",
      requestId: "login",
      sessionId: "",
    }),
  );
  const sessionId = await loggedIn;
  return { socket, sessionId };
}

function waitFor<T>(
  socket: WebSocket,
  matches: (body: VuuServerMessage["body"]) => boolean,
  returnSessionId = false,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Error("timed out waiting for message")),
      5_000,
    );
    const listener = ({ data }: MessageEvent) => {
      const message = JSON.parse(String(data)) as VuuServerMessage;
      if (matches(message.body)) {
        clearTimeout(timer);
        socket.removeEventListener("message", listener);
        resolve(
          (returnSessionId ? message.sessionId : message.body) as unknown as T,
        );
      }
    };
    socket.addEventListener("message", listener);
  });
}
