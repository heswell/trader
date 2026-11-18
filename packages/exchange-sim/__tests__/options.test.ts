import { describe, expect, test } from "bun:test";
import {
  InstrumentType,
  OrdType,
  PutCall,
  RejectReason,
  Side,
  validateOrder,
} from "@heswell/trading-schemas";
import { createExchangeSimulator } from "../src/engine/ExchangeSimulator";
import { listIndices } from "../src/reference/indices";
import { ALL_INSTRUMENTS } from "../src/reference/instruments";
import {
  listOptions,
  monthlyExpiries,
  optionRic,
  strikeGrid,
  strikeStep,
} from "../src/reference/options";
import { ManualClock } from "../src/util/clock";
import { createFakeTables } from "./fakeTables";

const NOW = Date.UTC(2026, 10, 12, 9, 0); // Thu 12 Nov 2026
const AT_1630 = 16 * 3600_000 + 30 * 60_000;
const aapl = ALL_INSTRUMENTS.find((i) => i.ric === "AAPL.OQ");
if (!aapl) throw Error("no AAPL.OQ");

describe("option chain reference data", () => {
  test("monthly expiries are third Fridays after now", () => {
    expect(monthlyExpiries(NOW, 3)).toEqual([
      Date.UTC(2026, 10, 20) + AT_1630,
      Date.UTC(2026, 11, 18) + AT_1630,
      Date.UTC(2027, 0, 15) + AT_1630,
    ]);
    // after expiry on the day: the next month
    expect(monthlyExpiries(Date.UTC(2026, 10, 20, 17), 1)).toEqual([
      Date.UTC(2026, 11, 18) + AT_1630,
    ]);
  });

  test("strike step is a nice number near 2.5% of spot", () => {
    expect(strikeStep(175)).toBe(5);
    expect(strikeStep(1000)).toBe(25);
    expect(strikeStep(4400)).toBe(200);
    expect(strikeStep(100)).toBe(2.5);
    expect(strikeGrid(176, 2)).toEqual([165, 170, 175, 180, 185]);
    expect(strikeGrid(10, 1)).toEqual([0.25, 0.5, 0.75].map((d) => 9.5 + d));
  });

  test("ric: root, strike, call or put month letter, year digit", () => {
    const dec = Date.UTC(2026, 11, 18);
    expect(optionRic("AAPL.OQ", PutCall.Call, 200, dec)).toBe("AAPL200L6");
    expect(optionRic("AAPL.OQ", PutCall.Put, 200, dec)).toBe("AAPL200X6");
    expect(optionRic("VOD.L", PutCall.Call, 102.5, Date.UTC(2027, 0, 15))).toBe(
      "VOD102D5A7",
    );
  });

  test("listOptions: 2 expiries x 21 strikes x call and put, liquid core", () => {
    const chain = listOptions(ALL_INSTRUMENTS, ["AAPL.OQ"], NOW);
    expect(chain).toHaveLength(84);
    const liquid = chain.filter((o) => o.liquid);
    // front expiry, nearest 2 strikes each side, calls and puts
    expect(liquid).toHaveLength(10);
    const front = monthlyExpiries(NOW, 1)[0];
    expect(liquid.every((o) => o.expiry === front)).toBe(true);
    const step = strikeStep(aapl.refPrice);
    for (const o of liquid)
      expect(Math.abs((o.strike ?? 0) - aapl.refPrice)).toBeLessThanOrEqual(
        2.5 * step,
      );
    const call = chain.find(
      (o) =>
        o.putCall === PutCall.Call && o.liquid && o.strike === liquid[4].strike,
    );
    expect(call).toMatchObject({
      instrumentType: InstrumentType.Option,
      underlying: "AAPL.OQ",
      currency: "USD",
      contractMultiplier: 100,
      tickSize: 0.01,
      lotSize: 1,
    });
    expect(call?.refPrice).toBeGreaterThan(0);
  });

  test("put-call parity holds on reference prices (to a tick or two)", () => {
    const chain = listOptions(ALL_INSTRUMENTS, ["AAPL.OQ"], NOW, {
      carryRate: 0,
    });
    for (const call of chain.filter((o) => o.putCall === PutCall.Call)) {
      const put = chain.find(
        (o) =>
          o.putCall === PutCall.Put &&
          o.strike === call.strike &&
          o.expiry === call.expiry,
      );
      const wing = Math.min(call.refPrice, put?.refPrice ?? 0) <= 0.01;
      if (wing) continue; // a one-tick floor breaks parity in the wings
      expect(
        Math.abs(
          call.refPrice -
            (put?.refPrice ?? 0) -
            (aapl.refPrice - (call.strike ?? 0)),
        ),
      ).toBeLessThan(0.02);
    }
  });

  test("index options: multiplier per point, 0.05 tick", () => {
    const indices = listIndices(ALL_INSTRUMENTS, ["STECH"]);
    const [first] = listOptions(
      [...ALL_INSTRUMENTS, ...indices],
      ["STECH"],
      NOW,
    );
    expect(first).toMatchObject({
      underlying: "STECH",
      contractMultiplier: 50,
      tickSize: 0.05,
    });
    expect(first.ric.startsWith("STECH")).toBe(true);
  });

  test("rejects unknown and non-equity underlyings", () => {
    expect(() => listOptions(ALL_INSTRUMENTS, ["NOPE.L"], NOW)).toThrow(
      /unknown underlying/,
    );
    const [option] = listOptions(ALL_INSTRUMENTS, ["AAPL.OQ"], NOW);
    expect(() =>
      listOptions([...ALL_INSTRUMENTS, option], [option.ric], NOW),
    ).toThrow(/not an equity or an index/);
  });

  test("a quote-only strike takes no orders", () => {
    const chain = listOptions(ALL_INSTRUMENTS, ["AAPL.OQ"], NOW);
    const quoteOnly = chain.find((o) => !o.liquid);
    if (!quoteOnly) throw Error("no quote-only strike");
    const order = {
      side: Side.Buy,
      ordType: OrdType.Limit,
      quantity: 1,
      price: quoteOnly.refPrice,
    };
    expect(validateOrder(order, quoteOnly)).toMatchObject({
      reason: RejectReason.RestrictedInstrument,
    });
    const liquid = chain.find((o) => o.liquid);
    if (!liquid) throw Error("no liquid strike");
    expect(
      validateOrder({ ...order, price: liquid.refPrice }, liquid),
    ).toBeUndefined();
  });
});

describe("ExchangeSimulator with options", () => {
  test("lists and publishes the chain; stock underlyings get books", () => {
    const clock = new ManualClock(NOW);
    const sim = createExchangeSimulator({
      clock: clock.now,
      config: { instruments: "MSFT.OQ", options: "AAPL.OQ,STECH" },
    });
    const tables = createFakeTables();
    sim.attachTables(tables);
    const options = sim.universe.filter(
      (i) => i.instrumentType === InstrumentType.Option,
    );
    expect(options).toHaveLength(168);
    expect(sim.isSimulated("AAPL.OQ")).toBe(true);
    expect(sim.indices.map((i) => i.ric)).toEqual(["STECH"]);
    // options are listed only in phase 1: no books
    expect(options.some((o) => sim.isSimulated(o.ric))).toBe(false);
    const row = tables.instruments.get(options[0].ric);
    expect(row).toMatchObject({
      instrumentType: InstrumentType.Option,
      putCall: options[0].putCall,
      strike: options[0].strike,
      liquid: options[0].liquid,
      simulated: false,
    });
    expect(sim.gateway.getInstrument(options[0].ric)?.strike).toBe(
      options[0].strike,
    );
  });

  test("config validation", () => {
    expect(() =>
      createExchangeSimulator({
        config: { options: "AAPL.OQ", optionsBookStrikes: 11 },
      }),
    ).toThrow(/optionsBookStrikes/);
    expect(() =>
      createExchangeSimulator({
        config: { options: "AAPL.OQ", optionsBookExpiries: 3 },
      }),
    ).toThrow(/optionsBookExpiries/);
  });
});
