import { describe, expect, test } from "bun:test";
import { createExchangeSimulator, ManualClock } from "@heswell/exchange-sim";
import {
  AlgoStrategy,
  isTerminalStatus,
  OrdStatus,
  RpcName,
  ScenarioStatus,
  Side,
} from "@heswell/trading-schemas";
import { createOms } from "../src/engine/OmsService";
import { parseClientBots } from "../src/flow/ClientFlow";
import { connectClientFlowToSim } from "../src/flow/simScenarios";
import { handleClientAdminRpc } from "../src/modules/oms/clientAdminRpc";
import { SIM_CLIENTS_OWNER } from "../src/reference/accounts";

const ADMIN = { name: "root", authorizations: ["sim-admin"] };
const TRADER = { name: "alice", authorizations: ["trading-execute"] };

/** The real simulator (bots on) + OMS with client bots, on a manual clock. */
const market = (config = {}, simConfig = {}) => {
  const clock = new ManualClock();
  const sim = createExchangeSimulator({
    clock: clock.now,
    config: {
      activeInstruments: 4,
      seed: 5,
      mmRate: 20,
      takerRate: 3,
      ...simConfig,
    },
  });
  const log: string[] = [];
  const oms = createOms(sim.gateway, {
    config: { flowRate: 0, seed: 13, ...config },
    rics: () => sim.books.map((b) => b.ric),
    clock: clock.now,
    log: (m) => log.push(m),
  });
  connectClientFlowToSim(oms, sim);
  let algoElapsed = 0;
  const run = (ms: number, warm = false) => {
    for (let t = 0; t < ms; t += 50) {
      clock.advance(50);
      sim.step();
      if (warm) continue;
      oms.flow.step(50);
      oms.clients.step(50);
      algoElapsed += 50;
      if (algoElapsed >= 250) {
        algoElapsed = 0;
        oms.engine.stepAlgos();
      }
    }
  };
  run(3_000, true); // market makers build their books first
  const parents = (account?: string) =>
    [...oms.engine.parents.values()].filter(
      (o) => !account || o.account === account,
    );
  const rpc = (name: string, params: object, user = ADMIN) =>
    handleClientAdminRpc(oms, name as never, params, user);
  return { clock, sim, oms, run, parents, rpc, log };
};

describe("ClientFlow", () => {
  test("oms.clientBots starts bots on the Sim clients desk that send algo parents", () => {
    const { oms, run, parents, log } = market({
      clientBots: "quant:1,pension:1",
    });
    const [quant, pension] = oms.clients.bots;
    expect(quant.persona).toBe("quant");
    expect(quant.account.account).toBe("CLIENT-01");
    expect(pension.account.account).toBe("CLIENT-02");
    run(3 * 60_000);
    const quantOrders = parents("CLIENT-01");
    const pensionOrders = parents("CLIENT-02");
    // quant: 8 / min of short TWAPs
    expect(quantOrders.length).toBeGreaterThan(10);
    expect(quantOrders.every((o) => o.strategy === AlgoStrategy.Twap)).toBe(
      true,
    );
    // pension: VWAPs, all on its programme side
    expect(pensionOrders.length).toBeGreaterThan(0);
    expect(pensionOrders.every((o) => o.strategy === AlgoStrategy.Vwap)).toBe(
      true,
    );
    expect(new Set(pensionOrders.map((o) => o.side)).size).toBe(1);
    for (const o of [...quantOrders, ...pensionOrders])
      expect(o.trader).toBe(SIM_CLIENTS_OWNER);
    // the orders trade: fills, positions and execution quality
    const stats = oms.clients.stats(quant);
    expect(stats.filledQty).toBeGreaterThan(0);
    expect(stats.filledUsd).toBeGreaterThan(0);
    expect(Number.isFinite(stats.slippageBps)).toBe(true);
    expect(quant.completed).toBeGreaterThan(0);
    expect(quant.rejected).toBe(0);
    expect(stats.live).toBeLessThanOrEqual(quant.params.maxLive);
    expect(
      oms.engine.getPosition("CLIENT-01", quantOrders[0].ric),
    ).toBeDefined();
    expect(log).toEqual([]);
  });

  test("is deterministic for a seed", () => {
    const summary = () => {
      const { run, parents } = market({ clientBots: "quant:1" });
      run(60_000);
      return parents().map(
        (o) => `${o.ric}:${o.side}:${o.state.quantity}:${o.state.cumQty}`,
      );
    };
    const a = summary();
    expect(a.length).toBeGreaterThan(0);
    expect(summary()).toEqual(a);
  });

  test("the background flow leaves the Sim clients accounts alone", () => {
    const { oms, run, parents } = market({ flowRate: 5 });
    run(20_000);
    expect(parents().length).toBeGreaterThan(20);
    expect(parents().some((o) => o.account.startsWith("CLIENT-"))).toBe(false);
    expect(oms.engine.accounts.get("CLIENT-05")?.desk).toBe("SIM-CLIENTS");
  });

  test("parseClientBots reads persona:count and refuses unknown personas", () => {
    expect(parseClientBots("pension, quant:3")).toEqual([
      { persona: "pension", count: 1 },
      { persona: "quant", count: 3 },
    ]);
    expect(() => parseClientBots("whale:1")).toThrow(/unknown persona/);
  });
});

describe("client admin RPCs", () => {
  test("add, set params, pause, submit and remove; logged in simEvents", () => {
    const { oms, sim, run, parents, rpc } = market();
    const added = rpc(RpcName.AddClientBot, {
      persona: "hedgeFund",
      params: JSON.stringify({ ordersPerMin: 20 }),
    });
    expect(added).toMatchObject({
      type: "SUCCESS_RESULT",
      data: { botId: "CB1", account: "CLIENT-01" },
    });
    const bot = oms.clients.getBot("CB1");
    expect(bot?.params.ordersPerMin).toBe(20);
    expect(bot?.params.povWeight).toBe(1);

    expect(
      rpc(RpcName.SetClientBotParams, {
        botId: "CB1",
        name: "sideMode",
        value: "sideways",
      }),
    ).toMatchObject({ type: "ERROR_RESULT" });
    expect(
      rpc(RpcName.SetClientBotParams, {
        persona: "hedgeFund",
        name: "maxPovPct",
        value: "x2",
      }),
    ).toMatchObject({ data: { botIds: ["CB1"] } });
    expect(bot?.params.maxPovPct).toBe(40);

    run(30_000);
    const before = parents("CLIENT-01").length;
    expect(before).toBeGreaterThan(0);
    expect(parents("CLIENT-01").every((o) => o.strategy === "POV")).toBe(true);
    rpc(RpcName.PauseClientBots, { botId: "CB1" });
    run(30_000);
    expect(parents("CLIENT-01").length).toBe(before);

    const ric = sim.books[0].ric;
    const submitted = rpc(RpcName.SubmitClientAlgo, {
      botId: "CB1",
      ric,
      side: Side.Sell,
      notionalUsd: 500_000,
      strategy: AlgoStrategy.Twap,
      durationMins: 5,
    });
    expect(submitted).toMatchObject({ type: "SUCCESS_RESULT" });
    const orderId = (submitted as { data: { orderId: string } }).data.orderId;
    expect(oms.engine.getOrder(orderId)).toMatchObject({
      ric,
      side: Side.Sell,
      strategy: AlgoStrategy.Twap,
    });

    expect(rpc(RpcName.RemoveClientBot, { botId: "CB1" })).toMatchObject({
      data: { botIds: ["CB1"] },
    });
    run(2_000);
    expect(
      parents("CLIENT-01").every((o) => isTerminalStatus(o.state.status)),
    ).toBe(true);
    expect(oms.engine.getOrder(orderId)?.state.status).toBe(
      OrdStatus.Cancelled,
    );
    const actions = sim.control.recent.map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        "addClientBot",
        "setClientBotParams",
        "pauseClientBots",
        "submitClientAlgo",
        "removeClientBot",
      ]),
    );
    expect(sim.control.recent.at(-1)).toMatchObject({
      user: "root",
      target: "CB1",
    });
  });

  test("sim-admin only; setFlowParams changes the background flow", () => {
    const { oms, rpc } = market();
    expect(
      rpc(RpcName.AddClientBot, { persona: "quant" }, TRADER),
    ).toMatchObject({
      type: "ERROR_RESULT",
      errorMessage: expect.stringContaining("PERMISSION_DENIED"),
    });
    expect(
      rpc(RpcName.SetFlowParams, { rate: 7, cancelRate: 0.5 }),
    ).toMatchObject({ data: { rate: 7, cancelRate: 0.5 } });
    expect(oms.flow.rate).toBe(7);
    expect(rpc(RpcName.AddClientBot, { persona: "whale" })).toMatchObject({
      type: "ERROR_RESULT",
    });
  });

  test("a trader account can be used for demos", () => {
    const { oms, run, parents, rpc } = market();
    rpc(RpcName.AddClientBot, {
      persona: "quant",
      account: "ACC-US-01",
      params: JSON.stringify({ ordersPerMin: 30 }),
    });
    run(10_000);
    expect(parents("ACC-US-01").length).toBeGreaterThan(0);
    expect(parents("ACC-US-01")[0].trader).toBe("alice");
    expect(oms.clients.bots[0].account.account).toBe("ACC-US-01");
  });
});

describe("client scenarios", () => {
  test("client-liquidation sells with a POV; revert removes the bot", () => {
    const { oms, sim, run, parents } = market();
    const runInfo = sim.scenarios.run(
      "client-liquidation",
      {},
      { user: "root" },
    );
    const [order] = parents();
    expect(order).toMatchObject({
      side: Side.Sell,
      strategy: AlgoStrategy.Pov,
      ric: runInfo.targets[0],
    });
    expect(order.algo?.participation).toBe(0.25);
    expect(oms.clients.bots[0].persona).toBe("liquidation");
    run(60_000);
    expect(order.state.cumQty).toBeGreaterThan(0);
    sim.scenarios.stop(runInfo.runId, true);
    run(1_000);
    expect(oms.clients.bots).toHaveLength(0);
    expect(isTerminalStatus(order.state.status)).toBe(true);
  });

  test("informed-client-news: the informed client buys the jump while makers lag", () => {
    const { oms, sim, run, parents } = market();
    const runInfo = sim.scenarios.run(
      "informed-client-news",
      { args: { bps: 150 } },
      { user: "root" },
    );
    const ric = runInfo.targets[0];
    const [bot] = oms.clients.bots;
    expect(bot.persona).toBe("informed");
    expect(bot.params.universe).toBe(ric);
    run(1_500);
    expect(parents()).toHaveLength(0); // no gap, no order
    run(30_000);
    const orders = parents();
    expect(orders.length).toBeGreaterThan(0);
    expect(orders.every((o) => o.side === Side.Buy && o.ric === ric)).toBe(
      true,
    );
    expect(oms.clients.stats(bot).filledQty).toBeGreaterThan(0);
    run(100_000);
    expect(sim.scenarios.getRun(runInfo.runId)?.status).toBe(
      ScenarioStatus.Done,
    );
    // reverted: the bot is gone and the makers no longer lag
    expect(oms.clients.bots).toHaveLength(0);
    const maker = sim
      .instrumentsFor(ric)[0]
      .bots.find((b) => b.kind === "marketMaker");
    expect(maker?.params.fairHalfLifeSecs).toBe(0);
  });

  test("pension-programme trades only the run's instruments, one side", () => {
    const { oms, sim, run, parents } = market();
    const runInfo = sim.scenarios.run(
      "pension-programme",
      { args: { side: "SELL", perMin: 20 } },
      { user: "root" },
    );
    run(60_000);
    const orders = parents();
    expect(orders.length).toBeGreaterThan(3);
    for (const o of orders) {
      expect(runInfo.targets).toContain(o.ric);
      expect(o.side).toBe(Side.Sell);
      expect(o.strategy).toBe(AlgoStrategy.Vwap);
    }
    expect(oms.clients.bots[0].params.programmeSide).toBe(Side.Sell);
  });
});
