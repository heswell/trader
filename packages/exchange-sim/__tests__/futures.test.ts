import { describe, expect, test } from "bun:test";
import {
  InstrumentType,
  roundToTick,
  TradingPhase,
} from "@heswell/trading-schemas";
import { createExchangeSimulator } from "../src/engine/ExchangeSimulator";
import type { InstrumentEvent } from "../src/gateway/types";
import { PriceModel } from "../src/engine/PriceModel";
import { BotKind } from "../src/engine/bots/Bot";
import {
  carriedPrice,
  futureRic,
  listFutures,
  quarterlyExpiries,
  thirdFriday,
  withFutures,
} from "../src/reference/futures";
import { ALL_INSTRUMENTS } from "../src/reference/instruments";
import { ManualClock } from "../src/util/clock";
import { Random } from "../src/util/random";
import { createFakeTables } from "./fakeTables";

const NOW = Date.UTC(2026, 10, 12, 9, 0); // Thu 12 Nov 2026
const AT_1630 = 16 * 3600_000 + 30 * 60_000;
const byRic = new Map(ALL_INSTRUMENTS.map((i) => [i.ric, i]));

describe("futures reference data", () => {
  test("third Friday of the month", () => {
    expect(thirdFriday(2026, 11)).toBe(Date.UTC(2026, 11, 18));
    expect(thirdFriday(2027, 2)).toBe(Date.UTC(2027, 2, 19));
    // a month starting on a Friday
    expect(thirdFriday(2027, 0)).toBe(Date.UTC(2027, 0, 15));
  });

  test("next quarterly expiries after now", () => {
    expect(quarterlyExpiries(NOW, 2)).toEqual([
      Date.UTC(2026, 11, 18) + AT_1630,
      Date.UTC(2027, 2, 19) + AT_1630,
    ]);
    // on expiry day, after the expiry time, the contract has gone
    const after = Date.UTC(2026, 11, 18, 17, 0);
    expect(quarterlyExpiries(after, 1)).toEqual([
      Date.UTC(2027, 2, 19) + AT_1630,
    ]);
    expect(quarterlyExpiries(NOW, 1, "12:00")).toEqual([
      Date.UTC(2026, 11, 18, 12, 0),
    ]);
  });

  test("ric is the root, month code and year digit", () => {
    expect(futureRic("AZN.L", Date.UTC(2026, 11, 18))).toBe("AZNZ6");
    expect(futureRic("AAPL.OQ", Date.UTC(2027, 2, 19))).toBe("AAPLH7");
  });

  test("listFutures builds contracts from the underlying", () => {
    const [front, next] = listFutures(ALL_INSTRUMENTS, ["AZN.L"], NOW);
    const azn = byRic.get("AZN.L");
    if (!azn) throw Error("no AZN.L");
    expect(front).toMatchObject({
      ric: "AZNZ6",
      instrumentType: InstrumentType.Future,
      underlying: "AZN.L",
      expiry: Date.UTC(2026, 11, 18) + AT_1630,
      currency: "GBX",
      exchange: azn.exchange,
      sector: azn.sector,
      contractMultiplier: 1000,
      lotSize: 1,
      usdPerPriceUnit: azn.usdPerPriceUnit,
    });
    expect(next.ric).toBe("AZNH7");
    // reference price is spot carried to expiry, on the future's fixed tick
    expect(front.refPrice).toBe(
      roundToTick(
        carriedPrice(azn.refPrice, 0.03, front.expiry ?? 0, NOW),
        front.tickSize,
      ),
    );
    expect(next.refPrice).toBeGreaterThan(front.refPrice);
    expect(front.tickBands).toBe("");
  });

  test("listFutures rejects unknown, non-equity and clashing underlyings", () => {
    expect(() => listFutures(ALL_INSTRUMENTS, ["NOPE.L"], NOW)).toThrow(
      /unknown underlying/,
    );
    const futures = listFutures(ALL_INSTRUMENTS, ["AZN.L"], NOW);
    expect(() =>
      listFutures([...ALL_INSTRUMENTS, ...futures], ["AZNZ6"], NOW),
    ).toThrow(/not an equity/);
    expect(() => listFutures(ALL_INSTRUMENTS, ["AZN.L", "AZN.L"], NOW)).toThrow(
      /clashes/,
    );
    expect(listFutures(ALL_INSTRUMENTS, [], NOW)).toEqual([]);
  });

  test("withFutures adds missing underlyings before their futures", () => {
    const futures = listFutures(ALL_INSTRUMENTS, ["AZN.L"], NOW, {
      contracts: 1,
    });
    const aapl = byRic.get("AAPL.OQ");
    if (!aapl) throw Error("no AAPL.OQ");
    const universe = [...ALL_INSTRUMENTS, ...futures];
    expect(withFutures([aapl], futures, universe).map((i) => i.ric)).toEqual([
      "AAPL.OQ",
      "AZN.L",
      "AZNZ6",
    ]);
  });
});

describe("anchored price model", () => {
  const anchored = (anchor: () => number, basisBps = 0, halfLifeSec = 60) => {
    const model = new PriceModel(100, 0.01, 0.3, 0.2);
    model.anchor = { price: anchor, basisBps, halfLifeSec };
    return model;
  };

  test("follows the anchor, not its own walk", () => {
    let spot = 100;
    const model = anchored(() => spot);
    const rng = new Random(1);
    model.step(60, rng, 1);
    expect(model.fairValue).toBeCloseTo(100, 10);
    spot = 104;
    model.step(60, rng, 1);
    expect(model.fairValue).toBeCloseTo(104, 10);
    // restoring a fair value is ignored: it follows the anchor
    model.fairValue = 90;
    expect(model.fairValue).toBeCloseTo(104, 10);
  });

  test("basis noise has about the configured spread and mean-reverts", () => {
    const model = anchored(() => 100, 10, 5);
    const rng = new Random(7);
    const samples: number[] = [];
    for (let i = 0; i < 20_000; i++) {
      model.step(1, rng, 1);
      samples.push(model.basisBps);
    }
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    const sd = Math.sqrt(
      samples.reduce((a, b) => a + (b - mean) ** 2, 0) / samples.length,
    );
    expect(Math.abs(mean)).toBeLessThan(1);
    expect(sd).toBeGreaterThan(8);
    expect(sd).toBeLessThan(12);
  });

  test("permanent impact goes into the basis and decays", () => {
    const model = anchored(() => 100, 0, 10);
    model.impact = { k: 0.001, permanentShare: 1, halfLifeSec: 30 };
    model.applyImpact(1, 100_000);
    const moved = model.basisBps;
    expect(moved).toBeGreaterThan(0);
    expect(model.fairValue).toBeGreaterThan(100);
    model.step(10, new Random(1), 10);
    expect(model.basisBps).toBeCloseTo(moved / 2, 1);
    const { basis = 0 } = model.exportState();
    expect((Math.exp(basis) - 1) * 1e4).toBeCloseTo(model.basisBps, 10);
  });
});

describe("ExchangeSimulator with futures", () => {
  const futuresSim = (config = {}) => {
    const clock = new ManualClock(NOW);
    const sim = createExchangeSimulator({
      clock: clock.now,
      config: {
        instruments: "AAPL.OQ",
        futures: "AZN.L",
        defaultVolatility: 0.3,
        ...config,
      },
    });
    return { clock, sim };
  };

  test("lists and simulates futures with their underlyings", () => {
    const { sim } = futuresSim();
    expect(sim.isSimulated("AAPL.OQ")).toBe(true);
    // the underlying gets a book although it is not in `instruments`
    expect(sim.isSimulated("AZN.L")).toBe(true);
    expect(sim.isSimulated("AZNZ6")).toBe(true);
    expect(sim.isSimulated("AZNH7")).toBe(true);
    expect(sim.gateway.getInstrument("AZNZ6")).toMatchObject({
      instrumentType: InstrumentType.Future,
      underlying: "AZN.L",
      contractMultiplier: 1000,
    });
    const informed = sim
      .getBots("AZNZ6")
      .filter((b) => b.kind === BotKind.Informed);
    expect(informed).toHaveLength(1);
    expect(informed[0].params.alwaysOn).toBe(true);
    expect(sim.getBots("AZN.L").some((b) => b.kind === BotKind.Informed)).toBe(
      false,
    );
  });

  test("a future's fair value tracks spot carried to expiry", () => {
    const { clock, sim } = futuresSim({ futuresBasisBps: 0 });
    const spot = sim.getBook("AZN.L");
    const future = sim.getBook("AZNZ6");
    if (!spot || !future) throw Error("no books");
    const expiry = future.instrument.expiry ?? 0;
    for (let i = 0; i < 500; i++) sim.step(clock.advance(20));
    const theoretical = carriedPrice(
      spot.model.fairValue,
      0.03,
      expiry,
      clock.time,
    );
    const gapBps = Math.abs(future.model.walk / theoretical - 1) * 1e4;
    // within a step's move of the underlying (anchors on the previous step)
    expect(gapBps).toBeLessThan(5);
    expect(future.model.volatility).toBe(spot.model.volatility);
  });

  test("publishes futures in the instruments table", () => {
    const { sim } = futuresSim();
    const tables = createFakeTables();
    sim.attachTables(tables);
    expect(tables.instruments.get("AZNZ6")).toMatchObject({
      instrumentType: InstrumentType.Future,
      underlying: "AZN.L",
      contractMultiplier: 1000,
      simulated: true,
    });
    expect(tables.instruments.get("AZN.L")?.instrumentType).toBe(
      InstrumentType.Equity,
    );
  });

  test("no futures configured leaves the universe unchanged", () => {
    const { sim } = futuresSim({ futures: "" });
    expect(sim.universe.length).toBe(ALL_INSTRUMENTS.length);
    expect(sim.isSimulated("AZN.L")).toBe(false);
  });

  test("an instruments list naming only futures simulates just those", () => {
    const { sim } = futuresSim({ instruments: "AZNZ6" });
    expect(sim.isSimulated("AZNZ6")).toBe(true);
    expect(sim.isSimulated("AZN.L")).toBe(true);
    expect(sim.isSimulated("AAPL.OQ")).toBe(false);
  });
});

describe("futures expiry and roll", () => {
  const expirySim = () => {
    const clock = new ManualClock(NOW);
    const sim = createExchangeSimulator({
      clock: clock.now,
      config: {
        instruments: "AAPL.OQ",
        futures: "AZN.L",
        defaultVolatility: 0.3,
      },
    });
    const tables = createFakeTables();
    sim.attachTables(tables);
    const events: InstrumentEvent[] = [];
    sim.gateway.onInstrumentEvent((e) => events.push(e));
    const front = sim.getBook("AZNZ6");
    if (!front) throw Error("no AZNZ6");
    return { clock, sim, tables, events, front };
  };

  test("expires at the last trading time, settles on spot and rolls", () => {
    const { clock, sim, tables, events, front } = expirySim();
    const expiry = front.instrument.expiry ?? 0;
    clock.time = expiry - 20;
    sim.step(clock.time);
    expect(front.isExpired).toBe(false);
    expect(events).toEqual([]);

    clock.time = expiry;
    sim.step(clock.time);
    const spot = sim.getBook("AZN.L");
    const settlement = front.settlementPrice ?? 0;
    expect(front.isExpired).toBe(true);
    expect(front.phase).toBe(TradingPhase.Closed);
    expect(settlement).toBe(
      roundToTick(spot?.model.fairValue ?? 0, front.schedule),
    );
    expect(sim.gateway.getInstrument("AZNZ6")?.settlementPrice).toBe(
      settlement,
    );
    expect(sim.gateway.getPhase("AZNZ6")).toBe(TradingPhase.Closed);
    expect(front.topOfBook()).toMatchObject({ bid: 0, ask: 0 });

    // the next quarterly contract after the last listed (Mar 27) is Jun 27
    expect(sim.isSimulated("AZNM7")).toBe(true);
    expect(sim.gateway.getInstrument("AZNM7")?.expiry).toBe(
      Date.UTC(2027, 5, 18) + AT_1630,
    );
    expect(events.map((e) => e.type)).toEqual(["EXPIRED", "LISTED"]);
    expect(events[0]).toMatchObject({
      ric: "AZNZ6",
      settlementPrice: settlement,
    });
    expect(events[1]).toMatchObject({ ric: "AZNM7" });

    sim.flush(clock.time);
    expect(tables.instruments.get("AZNZ6")?.settlementPrice).toBe(settlement);
    expect(tables.instruments.get("AZNM7")).toMatchObject({
      instrumentType: InstrumentType.Future,
      simulated: true,
    });
    expect(tables.prices.get("AZNZ6")?.phase).toBe(TradingPhase.Closed);

    // the new contract trades; the expired one stays closed through a session change
    for (let i = 0; i < 200; i++) sim.step(clock.advance(20));
    const next = sim.getBook("AZNM7");
    expect(next?.phase).toBe(TradingPhase.Continuous);
    expect(next?.topOfBook().bid).toBeGreaterThan(0);
    sim.setMarketPhase(TradingPhase.Closed);
    sim.setMarketPhase(TradingPhase.Continuous);
    expect(front.phase).toBe(TradingPhase.Closed);
    expect(() => sim.resumeInstrument("AZNZ6")).toThrow(/expired/);
    expect(sim.expireFuture("AZNZ6")).toBe(settlement);
  });

  test("expireFuture rejects anything but a simulated future", () => {
    const { sim } = expirySim();
    expect(() => sim.expireFuture("AZN.L")).toThrow(/not a simulated future/);
  });
});
