import { describe, expect, test } from "bun:test";
import { botParamKey, TradingPhase } from "@heswell/trading-schemas";
import type { MarketMakerParams } from "../src/engine/bots/MarketMaker";
import {
  parseOffset,
  ScenarioStatus,
  substituteArgs,
} from "../src/engine/control/ScenarioRunner";
import { parseParamValue } from "../src/engine/control/SimControl";
import { createExchangeSimulator } from "../src/engine/ExchangeSimulator";
import type {
  ExchangeJournalEntry,
  ExchangeState,
} from "../src/engine/persistence";
import { handleExchangeAdminRpc } from "../src/modules/exchange/exchangeAdminRpc";
import { ManualClock } from "../src/util/clock";
import { createFakeTables } from "./fakeTables";

const setup = (config = {}, { tables = true } = {}) => {
  const clock = new ManualClock();
  const sim = createExchangeSimulator({
    clock: clock.now,
    config: { instruments: "VOD.L,AAPL.OQ", defaultVolatility: 0.3, ...config },
  });
  const journal: ExchangeJournalEntry[] = [];
  sim.setJournal((e) => journal.push(structuredClone(e)));
  const fake = createFakeTables();
  if (tables) sim.attachTables(fake);
  const run = (ms: number) => {
    for (let t = 0; t < ms; t += 20) sim.step(clock.advance(20));
    sim.flush(clock.advance(sim.config.simPublishIntervalMs));
  };
  return { clock, sim, tables: fake, journal, run };
};

const mmParams = (sim: ReturnType<typeof setup>["sim"], id: string) =>
  sim.getBot(id)?.params as MarketMakerParams;

describe("parsing", () => {
  test("param values: absolute, x, +/-, clamped and rounded", () => {
    const spec = {
      name: "n",
      type: "integer",
      min: 1,
      max: 10,
      description: "",
    } as const;
    expect(parseParamValue(spec, "4", 2)).toBe(4);
    expect(parseParamValue(spec, "x2.6", 2)).toBe(5);
    expect(parseParamValue(spec, "+3", 2)).toBe(5);
    expect(parseParamValue(spec, "-5", 2)).toBe(1);
    expect(parseParamValue(spec, "99", 2)).toBe(10);
    expect(() => parseParamValue(spec, "lots", 2)).toThrow("not a number");
  });

  test("step times and args", () => {
    expect(parseOffset("+30s")).toBe(30_000);
    expect(parseOffset("+2m")).toBe(120_000);
    expect(parseOffset("+250ms")).toBe(250);
    expect(parseOffset("09:30")).toBeUndefined();
    expect(
      substituteArgs({ a: "$n", b: "+${n}m", c: ["$s"] }, { n: 5, s: "x" }),
    ).toEqual({
      a: 5,
      b: "+5m",
      c: ["x"],
    });
    expect(() => substituteArgs("$missing", {})).toThrow(
      "missing scenario arg",
    );
  });
});

describe("SimControl", () => {
  test("setBotParams by kind, with events and the changed marker", () => {
    const { sim, tables } = setup();
    const before = mmParams(sim, "VOD.L/MM1").halfSpreadTicks;
    const other = mmParams(sim, "AAPL.OQ/MM1").halfSpreadTicks;
    const rics = sim.control.setBotParams(
      { ric: "VOD.L", kind: "marketMaker" },
      "halfSpreadTicks",
      "x2",
      0,
      { user: "alice" },
    );
    expect(rics).toEqual(["VOD.L"]);
    expect(mmParams(sim, "VOD.L/MM1").halfSpreadTicks).toBe(before * 2);
    expect(mmParams(sim, "AAPL.OQ/MM1").halfSpreadTicks).toBe(other);
    const row = tables.botParams.get(
      botParamKey("VOD.L/MM1", "halfSpreadTicks"),
    );
    expect(row).toMatchObject({
      value: String(before * 2),
      baseline: String(before),
      changed: true,
    });
    const [event] = tables.simEvents.all();
    expect(event).toMatchObject({
      user: "alice",
      action: "setBotParams",
      target: "VOD.L marketMaker",
    });
    expect(JSON.parse(String(event.details))).toMatchObject({
      value: "x2",
      bots: 2,
    });
  });

  test("unknown parameter, kind and read-only are rejected", () => {
    const { sim } = setup();
    expect(() =>
      sim.control.setBotParams({ kind: "marketMaker" }, "nope", "1"),
    ).toThrow("no selected bot has a parameter nope");
    expect(() =>
      sim.control.setBotParams({ kind: "robot" }, "levels", "1"),
    ).toThrow("unknown bot kind robot");
  });

  test("a ramp moves a parameter linearly, then ends", () => {
    const { sim, clock } = setup();
    const id = "VOD.L/MM1";
    const from = mmParams(sim, id).halfSpreadTicks;
    sim.control.setBotParams(
      { botId: id },
      "halfSpreadTicks",
      String(from + 10),
      10,
    );
    expect(sim.control.rampCount).toBe(1);
    sim.step(clock.advance(5_000));
    expect(mmParams(sim, id).halfSpreadTicks).toBe(from + 5);
    sim.step(clock.advance(6_000));
    expect(mmParams(sim, id).halfSpreadTicks).toBe(from + 10);
    expect(sim.control.rampCount).toBe(0);
  });

  test("paused bots stop quoting and trading; resume brings them back", () => {
    const { sim, run } = setup();
    run(2_000);
    sim.control.pauseBots({ ric: "VOD.L" });
    const book = sim.getBook("VOD.L");
    const trades = book?.stats.tradeCount;
    run(3_000);
    expect(book?.stats.tradeCount).toBe(trades);
    expect(book?.topOfBook().bid).toBe(0);
    sim.control.resumeBots({ ric: "VOD.L" });
    run(3_000);
    expect(Number(book?.stats.tradeCount)).toBeGreaterThan(Number(trades));
  });

  test("add and remove a bot: rows follow", () => {
    const { sim, tables } = setup();
    const bot = sim.control.addBot("VOD.L", "noiseTaker", { baseQty: "50" });
    expect(bot.id).toBe("VOD.L/TAKER4");
    expect(bot.params.baseQty).toBe(50);
    expect(tables.bots.get(bot.id)).toBeDefined();
    expect(tables.botParams.get(botParamKey(bot.id, "baseQty"))).toBeDefined();
    sim.control.removeBot(bot.id);
    expect(sim.getBot(bot.id)).toBeUndefined();
    expect(tables.bots.get(bot.id)).toBeUndefined();
    expect(
      tables.botParams.get(botParamKey(bot.id, "baseQty")),
    ).toBeUndefined();
    expect(() => sim.control.addBot("VOD.L", "robot")).toThrow(
      "unknown bot kind",
    );
  });

  test("resetBotStats zeroes P&L and counters, keeps the position", () => {
    const { sim, run } = setup();
    run(5_000);
    const bot = sim.getBot("VOD.L/MM1");
    if (!bot) throw Error();
    const position = bot.port.ledger.position;
    sim.control.resetBotStats({ botId: bot.id });
    expect(bot.port.ledger.position).toBe(position);
    expect(bot.port.ledger.realisedPnl).toBe(0);
    expect(bot.port.ledger.orders).toBe(0);
  });

  test("instrument params and a fair-value jump", () => {
    const { sim } = setup();
    sim.control.setInstrumentParams("VOD.L", {
      driftBpsPerHour: 50,
      impactBps: 2,
    });
    const model = sim.getBook("VOD.L")?.model;
    expect(model?.driftBpsPerHour).toBe(50);
    expect(model?.impact.k).toBeCloseTo(0.0002, 8);
    const fair = Number(model?.walk);
    sim.control.shiftFairValue("VOD.L", 100);
    expect(Number(model?.walk) / fair).toBeCloseTo(1.01, 6);
  });

  test("roster, params, pause and drift survive a restart", () => {
    const a = setup({}, { tables: false });
    a.sim.control.addBot("VOD.L", "marketMaker");
    a.sim.control.setBotParams({ botId: "VOD.L/MM1" }, "levels", "2");
    a.sim.control.pauseBots({ botId: "VOD.L/TAKER1" });
    a.sim.control.removeBot("VOD.L/TAKER3");
    a.sim.control.setInstrumentParams("VOD.L", { driftBpsPerHour: -40 });
    const state = structuredClone(a.sim.exportState()) as ExchangeState;
    a.sim.control.setBotParams({ botId: "VOD.L/MM1" }, "levels", "3");
    for (const restore of [
      { state, entries: [] },
      { state: undefined, entries: a.journal },
    ]) {
      const b = setup({}, { tables: false });
      b.sim.restoreState(restore.state, restore.entries);
      const ids = b.sim.getBots("VOD.L").map((bot) => bot.localId);
      expect(ids).toEqual(["MM1", "MM2", "MM3", "TAKER1", "TAKER2"]);
      expect(mmParams(b.sim, "VOD.L/MM1").levels).toBe(restore.state ? 2 : 3);
      expect(b.sim.getBot("VOD.L/TAKER1")?.port.paused).toBe(true);
      expect(b.sim.getBook("VOD.L")?.model.driftBpsPerHour).toBe(-40);
    }
  });

  test("drift trends the walk", () => {
    const { sim, clock } = setup({ defaultVolatility: 0.0001 });
    sim.control.pauseBots({});
    sim.control.setInstrumentParams("VOD.L", { driftBpsPerHour: 1_000 });
    const model = sim.getBook("VOD.L")?.model;
    const start = Number(model?.walk);
    const hourMs = 3_600_000 / sim.config.timeScale;
    for (let t = 0; t < hourMs; t += 100) sim.step(clock.advance(100));
    expect(Number(model?.walk) / start).toBeCloseTo(Math.exp(0.1), 2);
  });
});

describe("scenarios", () => {
  test("the built-in scenarios are published", () => {
    const { tables } = setup();
    expect(tables.scenarios.all().map((row) => row.name)).toEqual([
      "calm",
      "volatile-open",
      "trending-day",
      "liquidity-crunch",
    ]);
  });

  test("calm runs its steps, then reverts and is done", () => {
    const { sim, tables, clock } = setup();
    const baseVol = sim.getBook("VOD.L")?.model.volatility;
    const spread = mmParams(sim, "VOD.L/MM1").halfSpreadTicks;
    const run = sim.scenarios.run(
      "calm",
      { args: { minutes: 1 } },
      { user: "bob" },
    );
    expect(run.targets).toEqual(["VOD.L", "AAPL.OQ"]);
    expect(sim.getBook("VOD.L")?.model.volatility).toBeCloseTo(
      Number(baseVol) / 2,
      8,
    );
    expect(sim.getSimulated("VOD.L")?.takerRate).toBe(sim.config.takerRate / 2);
    expect(run.status).toBe(ScenarioStatus.Running);
    sim.step(clock.advance(61_000));
    expect(run.status).toBe(ScenarioStatus.Done);
    expect(run.reverted).toBe(true);
    expect(sim.getBook("VOD.L")?.model.volatility).toBe(baseVol);
    expect(mmParams(sim, "VOD.L/MM1").halfSpreadTicks).toBe(spread);
    expect(tables.scenarioRuns.get(run.runId)).toMatchObject({
      status: "DONE",
      user: "bob",
      step: 4,
      steps: 4,
      reverted: true,
    });
    const events = tables.simEvents
      .all()
      .filter((row) => row.runId === run.runId);
    expect(events[0]).toMatchObject({ action: "runScenario", user: "bob" });
    expect(events.at(-1)).toMatchObject({ action: "revert" });
  });

  test("random targets, explicit rics and unknown names", () => {
    const { sim } = setup({ instruments: "VOD.L,AAPL.OQ,BARC.L,HSBA.L" });
    const run = sim.scenarios.run("trending-day", { args: { count: 2 } });
    expect(run.targets).toHaveLength(2);
    expect(sim.getBook(run.targets[0])?.model.driftBpsPerHour).toBe(300);
    const one = sim.scenarios.run("liquidity-crunch", { rics: ["HSBA.L"] });
    expect(one.targets).toEqual(["HSBA.L"]);
    expect(() => sim.scenarios.run("nope")).toThrow("unknown scenario nope");
  });

  test("stop with revert puts the settings back", () => {
    const { sim } = setup();
    const run = sim.scenarios.run("volatile-open", { rics: ["VOD.L"] });
    expect(sim.getBook("VOD.L")?.model.volatility).toBeCloseTo(0.9, 8);
    sim.scenarios.stop(run.runId, true);
    expect(run.status).toBe(ScenarioStatus.Stopped);
    expect(sim.getBook("VOD.L")?.model.volatility).toBe(0.3);
  });

  test("a run live at a restart is reverted and aborted", () => {
    const a = setup({}, { tables: false });
    a.sim.scenarios.run("volatile-open", { rics: ["VOD.L"] });
    const state = structuredClone(a.sim.exportState()) as ExchangeState;
    for (const restore of [
      { state, entries: [] },
      { state: undefined, entries: a.journal },
    ]) {
      const b = setup({}, { tables: false });
      b.sim.restoreState(restore.state, restore.entries);
      expect(b.sim.getBook("VOD.L")?.model.volatility).toBe(0.3);
      const [run] = b.sim.scenarios.runs;
      expect(run).toMatchObject({
        runId: "RUN1",
        status: ScenarioStatus.Aborted,
        reverted: true,
      });
      // run ids carry on after the restored ones
      expect(b.sim.scenarios.run("calm").runId).toBe("RUN2");
    }
    // a finished run is not aborted
    const c = setup({}, { tables: false });
    const run = c.sim.scenarios.run("calm", {
      rics: ["VOD.L"],
      args: { minutes: 1 },
    });
    c.sim.step(c.clock.advance(61_000));
    expect(run.status).toBe(ScenarioStatus.Done);
    const d = setup({}, { tables: false });
    d.sim.restoreState(undefined, c.journal);
    expect(d.sim.scenarios.runs).toHaveLength(0);
  });

  test("a failing step fails the run and reverts it", () => {
    const { sim, clock } = setup();
    sim.scenarios.define({
      name: "broken",
      description: "",
      steps: [
        {
          at: "+0s",
          action: "setInstrumentParams",
          params: { volatility: "x2" },
        },
        {
          at: "+1s",
          action: "setBotParams",
          params: { kind: "marketMaker", nope: 1 },
        },
      ],
    });
    const run = sim.scenarios.run("broken", { rics: ["VOD.L"] });
    sim.step(clock.advance(1_500));
    expect(run.status).toBe(ScenarioStatus.Failed);
    expect(run.error).toContain("no selected bot has a parameter nope");
    expect(sim.getBook("VOD.L")?.model.volatility).toBe(0.3);
  });
});

describe("control RPCs", () => {
  test("record the user, validate params and return ids", () => {
    const { sim, tables } = setup();
    expect(
      handleExchangeAdminRpc(
        sim,
        "setVolatility",
        { ric: "VOD.L", volatility: 0.4 },
        "carol",
      ),
    ).toEqual({ type: "SUCCESS_RESULT", data: { rics: ["VOD.L"] } });
    expect(tables.simEvents.all().at(-1)).toMatchObject({
      user: "carol",
      action: "setVolatility",
    });

    const added = handleExchangeAdminRpc(sim, "addBot", {
      ric: "VOD.L",
      kind: "marketMaker",
      params: '{"levels":2}',
    });
    expect(added).toEqual({
      type: "SUCCESS_RESULT",
      data: { rics: ["VOD.L"], botId: "VOD.L/MM3" },
    });
    expect(
      handleExchangeAdminRpc(sim, "addBot", {
        ric: "VOD.L",
        kind: "marketMaker",
        params: "{",
      }),
    ).toEqual({
      type: "ERROR_RESULT",
      errorMessage: "INVALID_REQUEST: params is not valid JSON",
    });
    expect(
      handleExchangeAdminRpc(sim, "setBotParams", {
        kind: "marketMaker",
        name: "levels",
        value: "3",
        overSecs: 5,
      }),
    ).toMatchObject({ type: "SUCCESS_RESULT" });
    expect(
      handleExchangeAdminRpc(sim, "pauseBots", { ric: "VOD.L" }),
    ).toMatchObject({
      type: "SUCCESS_RESULT",
    });
    expect(
      handleExchangeAdminRpc(sim, "shiftFairValue", {
        ric: "VOD.L",
        bps: 6_000,
      }),
    ).toMatchObject({
      type: "ERROR_RESULT",
    });

    const started = handleExchangeAdminRpc(sim, "runScenario", {
      name: "trending-day",
      rics: "VOD.L",
      args: '{"driftBpsPerHour":-200}',
    });
    expect(started).toEqual({
      type: "SUCCESS_RESULT",
      data: { rics: ["VOD.L"], runId: "RUN1" },
    });
    expect(sim.getBook("VOD.L")?.model.driftBpsPerHour).toBe(-200);
    expect(
      handleExchangeAdminRpc(sim, "stopScenario", {
        runId: "RUN1",
        revert: true,
      }),
    ).toMatchObject({
      type: "SUCCESS_RESULT",
    });
    expect(sim.getBook("VOD.L")?.model.driftBpsPerHour).toBe(0);
  });

  test("simSession row", () => {
    const { sim, tables } = setup();
    sim.control.pauseBots({ ric: "VOD.L" });
    sim.control.setMarketPhase(TradingPhase.Closed);
    sim.flush(sim.clock() + sim.config.simPublishIntervalMs);
    expect(tables.simSession.get("session")).toMatchObject({
      phase: "CLOSED",
      forced: true,
      pausedBots: 5,
      runningScenarios: 0,
    });
  });
});
