import { describe, expect, test } from "bun:test";
import { isOnTick, tickScheduleOf } from "@heswell/trading-schemas";
import {
  DEFAULT_CONFIG,
  loadExchangeSimConfig,
  validateConfig,
} from "../src/config";
import { createExchangeSimulator } from "../src/engine/ExchangeSimulator";
import { PriceModel } from "../src/engine/PriceModel";
import {
  ALL_INSTRUMENTS,
  selectActiveInstruments,
} from "../src/reference/instruments";
import { ManualClock } from "../src/util/clock";
import { Random } from "../src/util/random";

const run = (
  sim: ReturnType<typeof createExchangeSimulator>,
  clock: ManualClock,
  ms: number,
  stepMs = 20,
) => {
  for (let t = 0; t < ms; t += stepMs) sim.step(clock.advance(stepMs));
};

describe("Random", () => {
  test("is deterministic for a seed and forks independently", () => {
    const a = new Random(7);
    const b = new Random(7);
    const xs = Array.from({ length: 5 }, () => a.next());
    expect(Array.from({ length: 5 }, () => b.next())).toEqual(xs);
    expect(new Random(7).fork(1).next()).not.toBe(new Random(7).fork(2).next());
    for (const x of xs) expect(x >= 0 && x < 1).toBe(true);
  });

  test("poisson has roughly the right mean", () => {
    const rng = new Random(1);
    let total = 0;
    for (let i = 0; i < 10_000; i++) total += rng.poisson(0.3);
    expect(total / 10_000).toBeCloseTo(0.3, 1);
  });
});

describe("instrument universe", () => {
  test("is self-contained, unique and tick-consistent", () => {
    expect(ALL_INSTRUMENTS.length).toBeGreaterThanOrEqual(200);
    const rics = new Set(ALL_INSTRUMENTS.map(({ ric }) => ric));
    expect(rics.size).toBe(ALL_INSTRUMENTS.length);
    for (const instrument of ALL_INSTRUMENTS) {
      expect(instrument.refPrice).toBeGreaterThan(0);
      expect(instrument.lotSize).toBeGreaterThanOrEqual(1);
      expect(isOnTick(instrument.refPrice, tickScheduleOf(instrument))).toBe(
        true,
      );
    }
  });

  test("selects a venue-diverse active set, or explicit rics", () => {
    const active = selectActiveInstruments(ALL_INSTRUMENTS, 20);
    expect(active).toHaveLength(20);
    expect(new Set(active.map(({ exchange }) => exchange)).size).toBe(
      new Set(ALL_INSTRUMENTS.map(({ exchange }) => exchange)).size,
    );
    expect(
      selectActiveInstruments(ALL_INSTRUMENTS, 20, ["VOD.L", "AAPL.OQ"]).map(
        ({ ric }) => ric,
      ),
    ).toEqual(["VOD.L", "AAPL.OQ"]);
    expect(() =>
      selectActiveInstruments(ALL_INSTRUMENTS, 1, ["NOPE.X"]),
    ).toThrow();
  });
});

describe("config", () => {
  test("defaults, application.conf values and env overrides", () => {
    const conf = new Map<string, string | number>([
      ["exchangeSim.activeInstruments", 50],
      ["exchangeSim.instruments", "VOD.L"],
      ["exchangeSim.takerRate", 3],
    ]);
    const source = {
      has: (key: string) => conf.has(key),
      getString: (key: string) => String(conf.get(key)),
      getNumber: (key: string) => Number(conf.get(key)),
    };
    const config = loadExchangeSimConfig(source, {
      EXCHANGE_SIM_TAKER_RATE: "5",
      EXCHANGE_SIM_MM_LEVELS: "3",
    });
    expect(config.activeInstruments).toBe(50);
    expect(config.instruments).toBe("VOD.L");
    expect(config.takerRate).toBe(5);
    expect(config.mmLevels).toBe(3);
    expect(config.seed).toBe(DEFAULT_CONFIG.seed);
    expect(() =>
      loadExchangeSimConfig(undefined, { EXCHANGE_SIM_SEED: "x" }),
    ).toThrow();
    expect(() =>
      validateConfig({ ...DEFAULT_CONFIG, publishIntervalMs: 0 }),
    ).toThrow();
  });
});

describe("PriceModel", () => {
  test("stays inside the band and on tick under extreme volatility", () => {
    const instrument = ALL_INSTRUMENTS.find(({ ric }) => ric === "VOD.L");
    if (!instrument) throw Error("VOD.L missing");
    const schedule = tickScheduleOf(instrument);
    const model = new PriceModel(instrument.refPrice, schedule, 5, 0.1);
    const rng = new Random(3);
    expect(isOnTick(model.lowerBand, schedule)).toBe(true);
    expect(isOnTick(model.upperBand, schedule)).toBe(true);
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < 20_000; i++) {
      const fair = model.step(3600, rng);
      expect(model.isWithinBand(fair)).toBe(true);
      expect(isOnTick(model.fairOnTick, schedule)).toBe(true);
      min = Math.min(min, fair);
      max = Math.max(max, fair);
    }
    // it actually explores the band
    expect(min).toBeLessThan(instrument.refPrice * 0.95);
    expect(max).toBeGreaterThan(instrument.refPrice * 1.05);
  });

  test("zero volatility freezes fair value", () => {
    const [instrument] = ALL_INSTRUMENTS;
    const model = new PriceModel(
      instrument.refPrice,
      tickScheduleOf(instrument),
      0,
      0.2,
    );
    model.step(1000, new Random(1));
    expect(model.fairValue).toBe(instrument.refPrice);
  });
});

describe("ExchangeSimulator (book manager)", () => {
  test("creates one book per active instrument (default 200)", () => {
    const sim = createExchangeSimulator({ clock: new ManualClock().now });
    expect(sim.books).toHaveLength(DEFAULT_CONFIG.activeInstruments);
    expect(new Set(sim.books.map(({ ric }) => ric)).size).toBe(200);
    const listed = ALL_INSTRUMENTS.find(({ ric }) => !sim.isSimulated(ric));
    expect(listed).toBeDefined();
    expect(sim.getInstrument(listed?.ric ?? "")).toBeDefined();
    expect(sim.getBook(listed?.ric ?? "")).toBeUndefined();
  });

  test("is deterministic for a seed", () => {
    const outcome = (seed: number) => {
      const clock = new ManualClock();
      const sim = createExchangeSimulator({
        clock: clock.now,
        config: { activeInstruments: 10, seed },
      });
      run(sim, clock, 5_000);
      return [sim.bookEvents, sim.tradeCount, sim.books[0].stats.last];
    };
    expect(outcome(1)).toEqual(outcome(1));
    expect(outcome(1)).not.toEqual(outcome(2));
  });

  test("produces two-sided, uncrossed, on-tick books within the band", () => {
    const clock = new ManualClock();
    const sim = createExchangeSimulator({
      clock: clock.now,
      config: { activeInstruments: 30 },
    });
    run(sim, clock, 10_000);
    expect(sim.tradeCount).toBeGreaterThan(0);
    for (const book of sim.books) {
      const { bid, ask } = book.topOfBook();
      expect(bid).toBeGreaterThan(0);
      expect(ask).toBeGreaterThan(bid);
      expect(isOnTick(bid, book.schedule)).toBe(true);
      expect(isOnTick(ask, book.schedule)).toBe(true);
      expect(book.model.isWithinBand(book.model.fairValue)).toBe(true);
      if (book.stats.tradeCount > 0) {
        expect(book.stats.low).toBeLessThanOrEqual(book.stats.last);
        expect(book.stats.high).toBeGreaterThanOrEqual(book.stats.last);
        expect(book.model.isWithinBand(book.stats.last)).toBe(true);
      }
    }
  });

  test("caps elapsed time per step and the ops budget", () => {
    const clock = new ManualClock();
    const sim = createExchangeSimulator({
      clock: clock.now,
      config: { activeInstruments: 50, maxOpsPerStep: 50, maxStepMs: 100 },
    });
    sim.step(clock.now());
    const before = sim.bookEvents;
    // a 1 hour stall is treated as maxStepMs, and stops at the ops budget
    sim.step(clock.advance(3_600_000));
    expect(sim.bookEvents - before).toBeLessThan(500);
    expect(sim.deferredSteps).toBeGreaterThan(0);
  });
});
