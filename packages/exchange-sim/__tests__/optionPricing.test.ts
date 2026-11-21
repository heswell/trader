import { describe, expect, test } from "bun:test";
import {
  InstrumentType,
  OrdType,
  PutCall,
  RejectReason,
  Side,
  tickScheduleOf,
  validateOrder,
} from "@heswell/trading-schemas";
import { createExchangeSimulator } from "../src/engine/ExchangeSimulator";
import {
  MIN_SURFACE_VOL,
  OptionPricer,
  premiumVolatility,
  surfaceVol,
} from "../src/engine/OptionPricer";
import type { InstrumentEvent } from "../src/gateway/types";
import { optionRic } from "../src/reference/options";
import { ManualClock } from "../src/util/clock";
import { createFakeTables } from "./fakeTables";

// Thu 12 Nov 2026, in the session; the front expiry is Fri 20 Nov
const NOW = Date.UTC(2026, 10, 12, 14, 0);
const FRONT = Date.UTC(2026, 10, 20, 16, 30);
const SURFACE = { skew: -20, smile: 50 };

const fixedSpot = (price: number, volatility = 0.3) => ({
  price: () => price,
  listPrice: () => price,
  volatility,
});

const pricer = (price = 100, volScale = 1) =>
  new OptionPricer("XYZ", fixedSpot(price), {
    surface: SURFACE,
    carryRate: 0.03,
    volScale,
    minWidthVolPts: 1,
  });

const terms = (putCall: PutCall, strike: number, expiry = FRONT) => ({
  ric: "X",
  expiry,
  putCall,
  strike,
});

describe("vol surface and option pricer", () => {
  test("surface: ATM vol at the forward, put skew, a smile, a floor", () => {
    expect(surfaceVol(0.3, 100, 100, SURFACE)).toBeCloseTo(0.3, 12);
    const put90 = surfaceVol(0.3, 100, 90, SURFACE);
    const call110 = surfaceVol(0.3, 100, 110, SURFACE);
    expect(put90).toBeGreaterThan(0.3);
    expect(call110).toBeLessThan(put90);
    // ln(0.9) = -0.105: +2.1 points of skew, +0.55 of smile
    expect(put90).toBeCloseTo(0.3 + (20 * 0.10536 + 50 * 0.0111) / 100, 4);
    expect(surfaceVol(0.3, 100, 100, { skew: 0, smile: 50 })).toBe(0.3);
    expect(surfaceVol(0.01, 100, 250, { skew: -100, smile: 0 })).toBe(
      MIN_SURFACE_VOL,
    );
    // flat beyond ln(K/F) = ±1
    expect(surfaceVol(0.3, 100, 1000, SURFACE)).toBe(
      surfaceVol(0.3, 100, 100 * Math.E, SURFACE),
    );
  });

  test("put-call parity holds and vol scales with √timeScale", () => {
    const p = pricer(100);
    for (const strike of [80, 100, 125]) {
      const call = p.value(terms(PutCall.Call, strike), NOW);
      const put = p.value(terms(PutCall.Put, strike), NOW);
      expect(call.price - put.price).toBeCloseTo(call.forward - strike, 9);
      expect(call.vol).toBe(put.vol);
    }
    const scaled = pricer(100, Math.sqrt(10)).value(
      terms(PutCall.Call, 100),
      NOW,
    );
    expect(scaled.vol).toBeCloseTo(
      p.value(terms(PutCall.Call, 100), NOW).vol * Math.sqrt(10),
      9,
    );
    // a log vol shift of ln(1.1) is 10% more vol
    const shifted = p.value(terms(PutCall.Call, 100), NOW, Math.log(1.1));
    expect(shifted.vol).toBeCloseTo(
      p.value(terms(PutCall.Call, 100), NOW).vol * 1.1,
      12,
    );
  });

  test("theoretical quotes: around the model price, wider for more vega", () => {
    const p = pricer(100, Math.sqrt(10));
    const schedule = tickScheduleOf({ tickSize: 0.01, tickBands: "" });
    const atm = p.value(terms(PutCall.Call, 100), NOW);
    const wing = p.value(terms(PutCall.Call, 160), NOW);
    const q = p.quote(atm, schedule);
    expect(q.bid).toBeLessThan(atm.price);
    expect(q.ask).toBeGreaterThan(atm.price);
    expect(p.halfWidthTicks(atm, schedule)).toBeGreaterThan(
      p.halfWidthTicks(wing, schedule),
    );
    // at least two ticks each side, and no bid on a worthless wing
    const far = p.value(terms(PutCall.Call, 1000), NOW);
    expect(p.quote(far, schedule)).toEqual({ bid: undefined, ask: 0.02 });
    // the mid implies (about) the model vol
    const mid = ((q.bid ?? 0) + q.ask) / 2;
    expect(p.impliedVol(terms(PutCall.Call, 100), atm, mid) ?? 0).toBeCloseTo(
      atm.vol,
      2,
    );
  });

  test("premium volatility is the elasticity times the underlying's", () => {
    // delta 0.5, F 100, premium 5: elasticity 10
    expect(
      premiumVolatility({ delta: 0.5, forward: 100, price: 5 }, 0.3),
    ).toBeCloseTo(3, 12);
    expect(
      premiumVolatility({ delta: -0.01, forward: 100, price: 50 }, 0.3),
    ).toBe(0.3);
    expect(
      premiumVolatility({ delta: 0.1, forward: 100, price: 0.01 }, 0.3),
    ).toBeCloseTo(6, 12);
  });
});

describe("ExchangeSimulator option pricing and books", () => {
  const optionSim = (config = {}) => {
    const clock = new ManualClock(NOW);
    const sim = createExchangeSimulator({
      clock: clock.now,
      config: {
        instruments: "MSFT.OQ",
        options: "AAPL.OQ,STECH",
        defaultVolatility: 0.3,
        ...config,
      },
    });
    const tables = createFakeTables();
    sim.attachTables(tables);
    return { clock, sim, tables };
  };
  const run = ({ clock, sim }: ReturnType<typeof optionSim>, steps: number) => {
    for (let i = 0; i < steps; i++) {
      sim.step(clock.advance(20));
      if (i % 25 === 24) sim.flush(clock.time);
    }
    sim.flush(clock.time);
  };

  test("reference prices are model values; the liquid core has books", () => {
    const { sim } = optionSim();
    const chain = sim.optionChain("AAPL.OQ");
    expect(chain).toHaveLength(84);
    for (const def of chain) {
      const value = sim.optionValue(def.ric, NOW);
      expect(value).toBeDefined();
      expect(def.refPrice).toBeCloseTo(
        Math.max(def.tickSize, value?.price ?? 0),
        1,
      );
    }
    // AAPL at 175, strikes every 5: 165..185 in the front month
    const booked = chain.filter((o) => sim.isSimulated(o.ric));
    expect(booked.map((o) => o.strike)).toEqual([
      165, 165, 170, 170, 175, 175, 180, 180, 185, 185,
    ]);
    expect(booked.every((o) => o.expiry === FRONT && o.liquid)).toBe(true);
    // a book's model follows Black-76 (no vol noise yet)
    const ric = optionRic("AAPL.OQ", PutCall.Call, 175, FRONT);
    expect(sim.getBook(ric)?.model.fairValue).toBeCloseTo(
      sim.optionValue(ric)?.price ?? 0,
      2,
    );
    expect(sim.getBots(ric).map((b) => b.localId)).toEqual([
      "MM1",
      "MM2",
      "TAKER1",
      "TAKER2",
      "INF1",
    ]);
  });

  test("orders on a quote-only strike are rejected; liquid ones accepted", () => {
    const { sim } = optionSim();
    const order = {
      side: Side.Buy,
      ordType: OrdType.Limit,
      quantity: 1,
      price: 1,
    };
    const wing = sim.getInstrument(
      optionRic("AAPL.OQ", PutCall.Call, 200, FRONT),
    );
    const atm = sim.getInstrument(
      optionRic("AAPL.OQ", PutCall.Call, 175, FRONT),
    );
    if (!wing || !atm) throw Error("no options");
    expect(validateOrder(order, wing)?.reason).toBe(
      RejectReason.RestrictedInstrument,
    );
    expect(validateOrder(order, atm)).toBeUndefined();
  });

  test("the books trade around the model; quote-only strikes quote it", () => {
    const harness = optionSim();
    const { sim, tables } = harness;
    run(harness, 1500);
    for (const def of sim.optionChain("AAPL.OQ")) {
      const value = sim.optionValue(def.ric);
      const prices = tables.prices.get(def.ric);
      if (!value || !prices) throw Error(`no ${def.ric}`);
      const tick = def.tickSize;
      const book = sim.getBook(def.ric);
      if (book) {
        // the book's model is the model price with a little vol noise
        expect(book.stats.tradeCount).toBeGreaterThan(0);
        expect(Math.abs(book.model.fairValue / value.price - 1)).toBeLessThan(
          0.1,
        );
        const { bid, ask } = book.topOfBook();
        expect(bid).toBeGreaterThan(0);
        expect(ask - bid).toBeLessThan(value.vega * 0.1 + 10 * tick);
      } else {
        const { bid, ask } = prices as { bid: number | null; ask: number };
        expect(ask).toBeGreaterThan(value.price);
        if (bid !== null) expect(bid).toBeLessThan(value.price);
        expect(prices.last).toBeNull();
      }
    }
  });

  test("optionAnalytics: Greeks per option, parity on published theos", () => {
    const harness = optionSim();
    const { sim, tables } = harness;
    run(harness, 100);
    const rows = tables.optionAnalytics.all();
    expect(rows).toHaveLength(168);
    for (const def of sim.optionChain("STECH")) {
      if (def.putCall !== PutCall.Call) continue;
      const call = tables.optionAnalytics.get(def.ric);
      const put = tables.optionAnalytics.get(
        optionRic("STECH", PutCall.Put, def.strike ?? 0, def.expiry ?? 0),
      );
      if (!call || !put) throw Error(`no analytics for ${def.ric}`);
      const forward = call.forward as number;
      expect((call.theo as number) - (put.theo as number)).toBeCloseTo(
        forward - (def.strike ?? 0),
        4,
      );
      // far from the money a delta rounds to 0
      expect(call.delta as number).toBeGreaterThanOrEqual(0);
      expect(put.delta as number).toBeLessThanOrEqual(0);
      if (Math.abs((def.strike ?? 0) / forward - 1) < 0.1) {
        expect(call.delta as number).toBeGreaterThan(0);
        expect(put.delta as number).toBeLessThan(0);
        expect(call.theta as number).toBeLessThan(0);
      }
      expect(call.vega).toBe(put.vega);
      expect(call.theta as number).toBeLessThanOrEqual(0);
    }
    const atm = tables.optionAnalytics.get(
      optionRic("STECH", PutCall.Call, 1000, FRONT),
    );
    // as priced: the basket's vol scaled by √timeScale; base vol unscaled
    expect(atm?.modelVol as number).toBeGreaterThan(
      (atm?.baseVol as number) * 3,
    );
    expect(atm?.baseVol as number).toBeLessThan(0.3);
    expect(atm?.impliedVol as number).toBeGreaterThan(0);
  });

  test("re-centring books the new nearest strikes and keeps the old", () => {
    const harness = optionSim();
    const { sim, clock } = harness;
    const events: InstrumentEvent[] = [];
    sim.gateway.onInstrumentEvent((e) => events.push(e));
    const aapl = sim.getBook("AAPL.OQ");
    if (!aapl) throw Error("no AAPL.OQ");
    const before = sim
      .optionChain("AAPL.OQ")
      .filter((o) => sim.isSimulated(o.ric));
    aapl.model.shift(800); // ~189: the 190 strike is nearest
    sim.step(clock.advance(20));
    const after = sim
      .optionChain("AAPL.OQ")
      .filter((o) => sim.isSimulated(o.ric));
    for (const def of before) expect(sim.isSimulated(def.ric)).toBe(true);
    const added = after.filter((o) => !before.includes(o));
    expect([...new Set(added.map((o) => o.strike))]).toEqual([190, 195, 200]);
    expect(added.every((o) => o.liquid)).toBe(true);
    expect(sim.getInstrument(added[0].ric)?.liquid).toBe(true);
    expect(events.filter((e) => e.type === "LISTED")).toHaveLength(6);
    // the new books trade from here on
    run(harness, 500);
    expect(sim.getBook(added[0].ric)?.stats.tradeCount).toBeGreaterThan(0);
    expect(harness.tables.instruments.get(added[0].ric)?.liquid).toBe(true);
  });

  test("optionsMaxBooks caps the books and records it once", () => {
    const { sim, clock } = optionSim({ optionsMaxBooks: 12 });
    const aapl = sim.getBook("AAPL.OQ");
    if (!aapl) throw Error("no AAPL.OQ");
    aapl.model.shift(800);
    sim.step(clock.advance(20));
    aapl.model.shift(500);
    sim.step(clock.advance(20));
    const booked = sim
      .optionChain("AAPL.OQ")
      .filter((o) => sim.isSimulated(o.ric));
    expect(booked).toHaveLength(12);
    const capped = sim.control.recent.filter(
      (e) => e.action === "optionsMaxBooks",
    );
    expect(capped).toHaveLength(1);
    expect(capped[0].target).toBe("AAPL.OQ");
  });

  test("index options price off the index level", () => {
    const { sim } = optionSim();
    const level = sim.indexLevel("STECH") ?? 0;
    const value = sim.optionValue(
      optionRic("STECH", PutCall.Call, 1000, FRONT),
    );
    expect(value?.forward).toBeGreaterThan(level);
    expect((value?.forward ?? 0) / level - 1).toBeLessThan(0.001);
    expect(
      sim
        .optionChain("STECH")
        .every(
          (o) =>
            o.instrumentType === InstrumentType.Option && o.tickSize === 0.05,
        ),
    ).toBe(true);
  });
});
