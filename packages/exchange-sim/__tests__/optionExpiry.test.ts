import { describe, expect, test } from "bun:test";
import {
  intrinsicValue,
  PutCall,
  roundToTick,
  TradingPhase,
} from "@heswell/trading-schemas";
import { createExchangeSimulator } from "../src/engine/ExchangeSimulator";
import type { InstrumentEvent } from "../src/gateway/types";
import { optionRic } from "../src/reference/options";
import { ManualClock } from "../src/util/clock";
import { createFakeTables } from "./fakeTables";

// Thu 12 Nov 2026; expiries Fri 20 Nov, Fri 18 Dec, then Fri 15 Jan 2027
const NOW = Date.UTC(2026, 10, 12, 14, 0);
const NOV = Date.UTC(2026, 10, 20, 16, 30);
const DEC = Date.UTC(2026, 11, 18, 16, 30);
const JAN = Date.UTC(2027, 0, 15, 16, 30);

const expirySim = (config = {}) => {
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
  const events: InstrumentEvent[] = [];
  sim.gateway.onInstrumentEvent((e) => events.push(e));
  return { clock, sim, tables, events };
};

const expiriesOf = (sim: ReturnType<typeof expirySim>["sim"], ric: string) => [
  ...new Set(sim.optionChain(ric).map((o) => o.expiry)),
];

describe("option expiry", () => {
  test("the front expiry settles at intrinsic value against spot and level", () => {
    const { clock, sim, events } = expirySim();
    const aapl = sim.getBook("AAPL.OQ")?.model.fairValue ?? 0;
    const stech = sim.indexLevel("STECH") ?? 0;
    const front = sim
      .optionChain("AAPL.OQ")
      .concat(sim.optionChain("STECH"))
      .filter((o) => o.expiry === NOV);
    expect(front).toHaveLength(84);
    clock.time = NOV;
    sim.step(clock.time);

    const expired = events.filter((e) => e.type === "EXPIRED");
    expect(expired).toHaveLength(84);
    for (const def of front) {
      const spot = def.underlying === "STECH" ? stech : aapl;
      const settlement = roundToTick(
        intrinsicValue(def.putCall ?? PutCall.Call, spot, def.strike ?? 0),
        def.tickSize,
      );
      const event = expired.find((e) => e.ric === def.ric);
      expect(event).toMatchObject({ settlementPrice: settlement });
      expect(sim.getInstrument(def.ric)?.settlementPrice).toBe(settlement);
    }
    // out of the money: 0
    expect(
      sim.getInstrument(optionRic("AAPL.OQ", PutCall.Call, 225, NOV))
        ?.settlementPrice,
    ).toBe(0);
  });

  test("liquid books close for good; the chain rolls to the next month", () => {
    const { clock, sim, tables, events } = expirySim();
    const atm = optionRic("AAPL.OQ", PutCall.Call, 175, NOV);
    const book = sim.getBook(atm);
    if (!book) throw Error(`no ${atm}`);
    clock.time = NOV;
    sim.step(clock.time);
    sim.flush(clock.time);
    expect(book.isExpired).toBe(true);
    expect(book.phase).toBe(TradingPhase.Closed);
    expect(sim.getBots(atm).every((b) => b.port.restingCount === 0)).toBe(true);
    // the next session does not reopen it
    clock.time = Date.UTC(2026, 10, 23, 14, 0);
    sim.step(clock.time);
    expect(book.phase).toBe(TradingPhase.Closed);

    // Dec is the front month now, Jan is listed; the chain is full again
    expect(expiriesOf(sim, "AAPL.OQ")).toEqual([DEC, JAN]);
    expect(sim.optionChain("AAPL.OQ")).toHaveLength(84);
    expect(sim.optionChain("STECH")).toHaveLength(84);
    const jan = sim.getInstrument(optionRic("AAPL.OQ", PutCall.Put, 175, JAN));
    expect(jan).toMatchObject({ liquid: false, expiry: JAN });
    expect(tables.instruments.get(jan?.ric ?? "")).toBeDefined();
    // Dec's nearest strikes get books
    const decBooks = sim
      .optionChain("AAPL.OQ")
      .filter((o) => sim.isSimulated(o.ric));
    expect(decBooks).toHaveLength(10);
    expect(decBooks.every((o) => o.expiry === DEC && o.liquid)).toBe(true);
    expect(events.filter((e) => e.type === "LISTED")).toHaveLength(20);
  });

  test("published rows: expired quotes cleared, analytics dropped", () => {
    const { clock, sim, tables } = expirySim();
    const wing = optionRic("AAPL.OQ", PutCall.Call, 225, NOV);
    sim.flush(clock.time);
    expect(tables.prices.get(wing)?.ask).toBeGreaterThan(0);
    clock.time = NOV;
    sim.step(clock.time);
    clock.time += 1000;
    sim.flush(clock.time);
    expect(tables.prices.get(wing)).toMatchObject({
      bid: null,
      ask: null,
      phase: TradingPhase.Closed,
    });
    expect(tables.instruments.get(wing)?.settlementPrice).toBe(0);
    expect(tables.optionAnalytics.get(wing)).toBeUndefined();
    expect(tables.optionAnalytics.rowCount).toBe(168);
  });

  test("expireOptions rejects an underlying with no options", () => {
    const { sim } = expirySim();
    expect(() => sim.expireOptions("MSFT.OQ")).toThrow(/no listed options/);
  });
});
