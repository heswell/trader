import { describe, expect, test } from "bun:test";
import {
  OrdType,
  Side,
  TimeInForce,
  TradingPhase,
} from "@heswell/trading-schemas";
import { DEFAULT_CONFIG } from "../src/config";
import { createExchangeSimulator } from "../src/engine/ExchangeSimulator";
import { calibrateImpact } from "../src/engine/impact";
import { PriceModel } from "../src/engine/PriceModel";
import type { ExchangeState } from "../src/engine/persistence";
import { ManualClock } from "../src/util/clock";
import { Random } from "../src/util/random";
import { createFakeTables } from "./fakeTables";

const model = (k = 0.001) => {
  const m = new PriceModel(100, 0.01, 0.3, 0.2);
  m.impact = { k, permanentShare: 0.3, halfLifeSec: 10 };
  return m;
};

describe("PriceModel impact", () => {
  test("a trade moves fair; the permanent share stays, the rest fades", () => {
    const m = model();
    // $100k bought at 30% vol = k = 10 bps
    m.applyImpact(1, 100_000);
    expect((m.fairValue / 100 - 1) * 1e4).toBeCloseTo(10, 1);
    expect((m.walk / 100 - 1) * 1e4).toBeCloseTo(3, 1);
    expect(m.impactTodayBps).toBeCloseTo(3, 1);
    expect(m.impactOffsetBps).toBeCloseTo(7, 1);
    // one half-life with no volatility: half the transient is gone
    m.volatility = 0;
    m.step(0, new Random(1), 10);
    expect(m.impactOffsetBps).toBeCloseTo(3.5, 1);
    m.step(0, new Random(1), 1_000);
    expect(m.fairValue).toBeCloseTo(m.walk, 6);
    // a sell reverses it; impact scales with volatility
    m.volatility = 0.6;
    m.applyImpact(-1, 50_000);
    expect(m.impactTodayBps).toBeCloseTo(0, 1);
  });

  test("impact is clamped to the band; recentre moves the band", () => {
    const m = model(0.5);
    for (let i = 0; i < 20; i++) m.applyImpact(1, 1_000_000);
    expect(m.fairValue).toBe(m.upperBand);
    expect(m.upperBand).toBe(120);
    m.recentre();
    expect(m.bandCentre).toBe(120);
    expect(m.upperBand).toBe(144);
    expect(m.impactTodayBps).toBe(0);
    expect(m.impactOffsetBps).toBe(0);
  });

  test("state round trip", () => {
    const a = model();
    a.applyImpact(1, 500_000);
    a.recentre();
    a.applyImpact(-1, 200_000);
    const b = model();
    b.restoreState(a.exportState());
    b.fairValue = a.fairValue;
    expect(b.fairValue).toBeCloseTo(a.fairValue, 9);
    expect(b.walk).toBeCloseTo(a.walk, 9);
    expect(b.bandCentre).toBe(a.bandCentre);
    expect(b.impactTodayBps).toBeCloseTo(a.impactTodayBps, 9);
  });

  test("no impact: the walk is the fair value and has the full volatility", () => {
    const m = model(0);
    m.applyImpact(1, 1_000_000);
    expect(m.fairValue).toBe(100);
    expect(m.walkVolShare).toBe(1);
  });
});

describe("calibrateImpact", () => {
  test("splits variance between flow and walk; off at share 0", () => {
    const on = calibrateImpact(DEFAULT_CONFIG, 8, 20_000);
    expect(on.walkVolShare).toBe(0.75);
    expect(on.impact.k * 1e4).toBeGreaterThan(1);
    expect(on.impact.k * 1e4).toBeLessThan(2);
    // twice the share, about 1.41x k; four times the flow, half k
    expect(
      calibrateImpact({ ...DEFAULT_CONFIG, impactVolShare: 0.5 }, 8, 20_000)
        .impact.k / on.impact.k,
    ).toBeCloseTo(Math.SQRT2, 6);
    expect(
      calibrateImpact(DEFAULT_CONFIG, 32, 20_000).impact.k / on.impact.k,
    ).toBeCloseTo(0.5, 6);
    const off = calibrateImpact(
      { ...DEFAULT_CONFIG, impactVolShare: 0 },
      8,
      20_000,
    );
    expect(off.impact.k).toBe(0);
    expect(off.walkVolShare).toBe(1);
    expect(calibrateImpact(DEFAULT_CONFIG, 0, 20_000).impact.k).toBe(0);
  });

  test("config is validated", () => {
    expect(() =>
      createExchangeSimulator({ config: { impactVolShare: 1 } }),
    ).toThrow("impactVolShare must be in [0, 1)");
    expect(() =>
      createExchangeSimulator({ config: { impactPermanentShare: 0 } }),
    ).toThrow("impactPermanentShare must be in (0, 1]");
  });
});

const RIC = "AAPL.OQ";
const setup = (config = {}) => {
  const clock = new ManualClock();
  const sim = createExchangeSimulator({
    clock: clock.now,
    config: { instruments: `${RIC},VOD.L`, defaultVolatility: 0.3, ...config },
  });
  const run = (ms: number, each?: () => void) => {
    for (let t = 0; t < ms; t += 20) {
      sim.step(clock.advance(20));
      each?.();
    }
  };
  return { clock, sim, run };
};

describe("impact in the simulator", () => {
  test("an OMS market order moves fair value its way", () => {
    // k is fixed at startup from the default flow; pausing takers later
    // leaves it, so only the order below moves the price
    const { sim, run } = setup();
    const s = sim.getSimulated(RIC);
    if (!s) throw Error();
    s.takerRate = 0;
    run(1_000);
    const book = s.book;
    const before = book.model.fairValue;
    const today = book.model.impactTodayBps;
    sim.gateway.submit({
      account: "ACC1",
      clOrdId: "big",
      ric: RIC,
      side: Side.Buy,
      ordType: OrdType.Market,
      quantity: 2_000,
      timeInForce: TimeInForce.ImmediateOrCancel,
    });
    expect(book.stats.volume).toBeGreaterThan(0);
    expect(book.model.fairValue).toBeGreaterThan(before);
    expect(book.model.impactTodayBps).toBeGreaterThan(today);
  });

  test("heavy taker flow: mid keeps tracking fair value", () => {
    const { sim, run } = setup({ takerRate: 40 });
    const gaps: number[] = [];
    let t = 0;
    run(120_000, () => {
      if (++t % 50 !== 0) return;
      const book = sim.getBook(RIC);
      const top = book?.topOfBook();
      if (!book || !top || !(top.bid > 0 && top.ask > 0)) return;
      const mid = (top.bid + top.ask) / 2;
      gaps.push(Math.abs(mid / book.model.fairValue - 1) * 1e4);
    });
    gaps.sort((a, b) => a - b);
    const median = gaps[Math.floor(gaps.length / 2)];
    expect(gaps.length).toBeGreaterThan(100);
    expect(median).toBeLessThan(15);
    const book = sim.getBook(RIC);
    if (!book) throw Error();
    expect(book.model.isWithinBand(book.model.fairValue)).toBe(true);
  });

  test("the session close recentres the band on fair value", () => {
    const { sim, run } = setup();
    run(5_000);
    const book = sim.getBook(RIC);
    if (!book) throw Error();
    sim.setMarketPhase(TradingPhase.Closed as never);
    expect(book.model.bandCentre).toBeCloseTo(book.model.fairValue, 9);
    expect(book.model.impactTodayBps).toBe(0);
  });

  test("impact state survives a snapshot restore", () => {
    const a = setup();
    a.run(5_000);
    const state = structuredClone(a.sim.exportState()) as ExchangeState;
    const book = a.sim.getBook(RIC);
    const b = setup();
    b.sim.restoreState(state);
    const restored = b.sim.getBook(RIC);
    expect(restored?.model.fairValue).toBeCloseTo(
      book?.model.fairValue ?? 0,
      9,
    );
    expect(restored?.model.impactOffsetBps).toBeCloseTo(
      book?.model.impactOffsetBps ?? 0,
      9,
    );
  });
});

describe("sim history and fills tables", () => {
  test("simSamples: volume by owner group adds up to the book's volume", () => {
    const { sim, run, clock } = setup();
    const tables = createFakeTables();
    sim.attachTables(tables);
    const startVolume = sim.getBook(RIC)?.stats.volume ?? 0;
    run(10_000, () => sim.flush());
    sim.flush(clock.advance(1_000));
    const rows = tables.simSamples.all().filter((row) => row.ric === RIC);
    expect(rows.length).toBeGreaterThanOrEqual(10);
    const sum = (row: Record<string, unknown>) =>
      ["mm", "taker", "oms", "bot"].reduce(
        (n, g) => n + Number(row[`${g}Buy`]) + Number(row[`${g}Sell`]),
        0,
      );
    const traded = rows.reduce((n, row) => n + sum(row), 0);
    expect(traded).toBe((sim.getBook(RIC)?.stats.volume ?? 0) - startVolume);
    const last = rows.at(-1) as Record<string, unknown>;
    expect(Number(last.fair)).toBeGreaterThan(0);
    expect(
      Number(last.takerBuy) + Number(last.takerSell),
    ).toBeGreaterThanOrEqual(0);
  });

  test("botFills: both sides of every trade, with markouts after markoutMs", () => {
    const { sim, run, clock } = setup();
    const tables = createFakeTables();
    sim.attachTables(tables);
    run(3_000, () => sim.flush());
    const fills = tables.botFills.all();
    const trades = tables.trades.all();
    expect(fills.length).toBe(trades.length * 2);
    expect(fills.every((row) => row.markoutBps === null)).toBe(true);
    const sides = new Set(fills.map((row) => row.liquidity));
    expect([...sides].sort()).toEqual(["ADDED", "REMOVED"]);
    const takers = fills.filter((row) => row.group === "taker");
    expect(takers.length).toBeGreaterThan(0);
    run(5_000, () => sim.flush());
    sim.flush(clock.advance(0));
    const early = tables.botFills
      .all()
      .filter((row) => Number(row.timestamp) <= clock.now() - 5_000);
    expect(early.length).toBeGreaterThan(0);
    expect(early.every((row) => typeof row.markoutBps === "number")).toBe(true);
  });

  test("botHistory samples every bot; botFillsCapacity 0 turns fills off", () => {
    const { sim, run } = setup({ botFillsCapacity: 0 });
    const tables = createFakeTables();
    sim.attachTables(tables);
    run(11_000, () => sim.flush());
    const history = tables.botHistory.all();
    expect(history.length).toBe(3 * sim.getBots().length);
    expect(tables.botFills.all()).toHaveLength(0);
    const simBook = tables.simBooks.get(RIC);
    expect(Number(simBook?.impactK)).toBeGreaterThan(0);
    expect(Number(simBook?.bandHigh)).toBeGreaterThan(Number(simBook?.bandLow));
  });
});
