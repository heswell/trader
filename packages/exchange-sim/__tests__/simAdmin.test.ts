import { describe, expect, test } from "bun:test";
import { botParamKey } from "@heswell/trading-schemas";
import { createExchangeSimulator } from "../src/engine/ExchangeSimulator";
import {
  canAdminSim,
  SIM_ADMIN_ROLE,
  simAdminDenied,
} from "../src/modules/exchange/simAdminAccess";
import { ManualClock } from "../src/util/clock";
import { createFakeTables } from "./fakeTables";

const setup = (config = {}) => {
  const clock = new ManualClock();
  const sim = createExchangeSimulator({
    clock: clock.now,
    config: {
      instruments: "VOD.L,AAPL.OQ",
      defaultVolatility: 0.5,
      ...config,
    },
  });
  const tables = createFakeTables();
  sim.attachTables(tables);
  const run = (ms: number) => {
    for (let t = 0; t < ms; t += 20) {
      sim.step(clock.advance(20));
      if (t % 100 === 0) sim.flush();
    }
    // past the publish interval, with no step: rows match the state now
    sim.flush(clock.advance(sim.config.simPublishIntervalMs));
  };
  return { clock, sim, tables, run };
};

describe("sim-admin access", () => {
  test("sim-admin always; no roles only in auto mode", () => {
    const admin = { name: "a", authorizations: [SIM_ADMIN_ROLE] };
    const trader = { name: "t", authorizations: ["trading-view"] };
    const dev = { name: "d", authorizations: [] };
    expect(canAdminSim(admin, "strict")).toBe(true);
    expect(canAdminSim(admin, "auto")).toBe(true);
    expect(canAdminSim(trader, "auto")).toBe(false);
    expect(canAdminSim(trader, "strict")).toBe(false);
    expect(canAdminSim(dev, "auto")).toBe(true);
    expect(canAdminSim(dev, "strict")).toBe(false);
    expect(canAdminSim(undefined, "strict")).toBe(false);
    expect(simAdminDenied(trader)).toBe(
      "PERMISSION_DENIED: t needs the sim-admin role",
    );
  });

  test("permissionMode is validated", () => {
    expect(() =>
      createExchangeSimulator({ config: { permissionMode: "open" } }),
    ).toThrow("exchangeSim.permissionMode must be 'auto' or 'strict'");
  });
});

describe("SimAdminPublisher", () => {
  test("botParams: one row per bot parameter, published at attach", () => {
    const { sim, tables } = setup();
    const bots = sim.getBots();
    const mm = bots.find((bot) => bot.localId === "MM1");
    if (!mm) throw Error();
    const row = tables.botParams.get(botParamKey(mm.id, "halfSpreadTicks"));
    expect(row).toMatchObject({
      botId: mm.id,
      kind: "marketMaker",
      name: "halfSpreadTicks",
      type: "integer",
      value: String(mm.params.halfSpreadTicks),
      min: 1,
      unit: "ticks",
      readOnly: false,
    });
    // 4 MM params x 2 makers + 2 taker params x 3 takers, per instrument
    expect(tables.botParams.all()).toHaveLength(2 * (4 * 2 + 2 * 3));
  });

  test("simBooks and bots rows reflect the simulator", () => {
    const { sim, tables, run } = setup();
    run(10_000);
    const book = sim.getBook("AAPL.OQ");
    if (!book) throw Error();
    const simBook = tables.simBooks.get("AAPL.OQ");
    expect(simBook?.phase).toBe("CONTINUOUS");
    expect(simBook?.fair).toBeCloseTo(book.model.fairValue, 4);
    expect(simBook?.volatility).toBe(0.5);
    expect(simBook?.bots).toBe(5);
    expect(simBook?.mmRate).toBe(sim.config.mmRate);
    expect(simBook?.tradeCount).toBe(book.stats.tradeCount);
    expect(Number(simBook?.spreadBps)).toBeGreaterThan(0);
    // realised and model volatility are on the same (annualised) scale
    const realised = Number(simBook?.realisedVolatility);
    expect(realised).toBeGreaterThan(0.05);
    expect(realised).toBeLessThan(5);

    const rows = tables.bots.all().filter((row) => row.ric === "AAPL.OQ");
    expect(rows.map((row) => row.localId)).toEqual([
      "MM1",
      "MM2",
      "TAKER1",
      "TAKER2",
      "TAKER3",
    ]);
    const makers = rows.filter((row) => row.kind === "marketMaker");
    expect(simBook?.mmInventory).toBe(
      makers.reduce((n, row) => n + Number(row.position), 0),
    );
    // bots only trade with each other: positions net to zero
    expect(rows.reduce((n, row) => n + Number(row.position), 0)).toBe(0);
    for (const row of makers) {
      expect(row.quotes).toBe(row.restingOrders);
      expect(row.rate).toBeCloseTo(sim.config.mmRate / 2, 3);
      expect(typeof row.skewTicks).toBe("number");
    }
    for (const row of rows.filter((r) => r.kind === "noiseTaker")) {
      expect(row.rate).toBeCloseTo(sim.config.takerRate / 3, 3);
      expect(Number(row.effectiveRate)).toBeGreaterThan(0);
      expect(row.skewTicks).toBeNull();
      expect(Number(row.totalPnlUsd)).toBeCloseTo(
        Number(row.realisedPnlUsd) + Number(row.unrealisedPnlUsd),
        1,
      );
    }
  });

  test("updates at simPublishIntervalMs, not every flush", () => {
    const { sim, clock } = setup({ simPublishIntervalMs: 1_000 });
    const publisher = sim.simAdminPublisher;
    if (!publisher) throw Error();
    const after = publisher.updates;
    sim.step(clock.advance(300));
    sim.flush();
    expect(publisher.updates).toBe(after);
    sim.step(clock.advance(800));
    sim.flush();
    expect(publisher.updates).toBe(after + 2 + 2 * 5);
  });

  test("simPublishIntervalMs 0 disables the admin tables", () => {
    const { sim, tables } = setup({ simPublishIntervalMs: 0 });
    expect(sim.simAdminPublisher).toBeUndefined();
    expect(tables.bots.all()).toHaveLength(0);
  });
});
