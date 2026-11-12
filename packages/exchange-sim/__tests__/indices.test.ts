import { describe, expect, test } from "bun:test";
import {
  InstrumentType,
  OrdType,
  RejectReason,
  roundToTick,
  Side,
  validateOrder,
} from "@heswell/trading-schemas";
import { createExchangeSimulator } from "../src/engine/ExchangeSimulator";
import { listFutures } from "../src/reference/futures";
import {
  INDEX_BASE,
  indexLevel,
  listIndices,
  SYNTHETIC_INDICES,
  withConstituents,
} from "../src/reference/indices";
import { ALL_INSTRUMENTS } from "../src/reference/instruments";
import { ManualClock } from "../src/util/clock";
import { createFakeTables } from "./fakeTables";

const NOW = Date.UTC(2026, 10, 12, 9, 0); // Thu 12 Nov 2026

describe("synthetic index reference data", () => {
  test("every index's constituents are in the universe, in one currency", () => {
    const indices = listIndices(
      ALL_INSTRUMENTS,
      SYNTHETIC_INDICES.map((s) => s.ric),
    );
    expect(indices.map((i) => i.ric)).toEqual(["STECH", "SUK"]);
    expect(indices[0]).toMatchObject({
      instrumentType: InstrumentType.Index,
      currency: "USD",
      refPrice: INDEX_BASE,
      constituents: expect.arrayContaining(["AAPL.OQ", "MSFT.OQ"]),
    });
    expect(indices[1].currency).toBe("GBX");
  });

  test("listIndices rejects an unknown index and drops duplicates", () => {
    expect(() => listIndices(ALL_INSTRUMENTS, ["NOPE"])).toThrow(
      /unknown index NOPE/,
    );
    expect(listIndices(ALL_INSTRUMENTS, ["SUK", "SUK"])).toHaveLength(1);
  });

  test("level is equal weighted on reference prices", () => {
    expect(indexLevel([100, 50], [100, 50])).toBe(INDEX_BASE);
    // +10% and -10%: unchanged; +20% on one of two: +10%
    expect(indexLevel([100, 50], [110, 45])).toBeCloseTo(INDEX_BASE);
    expect(indexLevel([100, 50], [120, 50])).toBeCloseTo(1100);
  });

  test("withConstituents adds missing constituents once", () => {
    const [suk] = listIndices(ALL_INSTRUMENTS, ["SUK"]);
    const vod = ALL_INSTRUMENTS.find((i) => i.ric === "VOD.L");
    if (!vod) throw Error("no VOD.L");
    const rics = withConstituents([vod], [suk], ALL_INSTRUMENTS).map(
      (i) => i.ric,
    );
    expect(rics[0]).toBe("VOD.L");
    expect(new Set(rics).size).toBe(rics.length);
    expect(rics).toHaveLength(suk.constituents?.length ?? 0);
  });

  test("index futures: 0.1 point tick and a per-point multiplier", () => {
    const indices = listIndices(ALL_INSTRUMENTS, ["STECH", "SUK"]);
    const [stech, , suk] = listFutures(
      [...ALL_INSTRUMENTS, ...indices],
      ["STECH", "SUK"],
      NOW,
    );
    expect(stech).toMatchObject({
      ric: "STECHZ6",
      underlying: "STECH",
      instrumentType: InstrumentType.Future,
      contractMultiplier: 50,
      tickSize: 0.1,
      currency: "USD",
    });
    expect(stech.refPrice).toBeGreaterThan(INDEX_BASE);
    expect(suk).toMatchObject({ ric: "SUKZ6", contractMultiplier: 1000 });
  });

  test("an index is not tradeable", () => {
    const [stech] = listIndices(ALL_INSTRUMENTS, ["STECH"]);
    expect(
      validateOrder(
        { side: Side.Buy, ordType: OrdType.Limit, quantity: 1, price: 1000 },
        stech,
      )?.reason,
    ).toBe(RejectReason.RestrictedInstrument);
  });
});

describe("ExchangeSimulator with indices", () => {
  const indexSim = (config = {}) => {
    const clock = new ManualClock(NOW);
    const sim = createExchangeSimulator({
      clock: clock.now,
      config: {
        instruments: "AAPL.OQ",
        futures: "STECH",
        defaultVolatility: 0.3,
        ...config,
      },
    });
    return { clock, sim };
  };

  test("an index future lists the index and books its constituents", () => {
    const { sim } = indexSim();
    expect(sim.indices.map((i) => i.ric)).toEqual(["STECH"]);
    // the index itself has no book
    expect(sim.isSimulated("STECH")).toBe(false);
    for (const ric of ["MSFT.OQ", "NVDA.OQ", "STECHZ6", "STECHH7"])
      expect(sim.isSimulated(ric)).toBe(true);
    expect(sim.indexLevel("STECH")).toBeCloseTo(INDEX_BASE, 6);
    expect(sim.indexLevel("AAPL.OQ")).toBeUndefined();
  });

  test("indices can be listed without futures", () => {
    const { sim } = indexSim({ futures: "", indices: "SUK" });
    expect(sim.indices.map((i) => i.ric)).toEqual(["SUK"]);
    expect(sim.isSimulated("HSBA.L")).toBe(true);
    expect(sim.isSimulated("SUKZ6")).toBe(false);
  });

  test("the future anchors on the index level and settles on it", () => {
    const { clock, sim } = indexSim({ futuresBasisBps: 0 });
    const future = sim.getBook("STECHZ6");
    if (!future) throw Error("no STECHZ6");
    for (let i = 0; i < 500; i++) sim.step(clock.advance(20));
    const level = sim.indexLevel("STECH") ?? 0;
    expect(level).not.toBe(INDEX_BASE);
    // the basket is calmer than any one stock
    expect(future.model.volatility).toBeLessThan(0.3);
    const gapBps = Math.abs(future.model.walk / level - 1) * 1e4;
    // carry to Dec is ~0.3%, plus at most a step's move
    expect(gapBps).toBeLessThan(40);

    const settlement = sim.expireFuture("STECHZ6");
    expect(settlement).toBe(
      roundToTick(sim.indexLevel("STECH") ?? 0, future.schedule),
    );
    expect(sim.isSimulated("STECHM7")).toBe(true);
  });

  test("publishes the index as instrument and level", () => {
    const { clock, sim } = indexSim();
    const tables = createFakeTables();
    sim.attachTables(tables);
    expect(tables.instruments.get("STECH")).toMatchObject({
      instrumentType: InstrumentType.Index,
      simulated: true,
    });
    expect(tables.prices.get("STECH")).toMatchObject({
      last: INDEX_BASE,
      close: INDEX_BASE,
    });
    for (let i = 0; i < 500; i++) sim.step(clock.advance(20));
    sim.flush(clock.time);
    const row = tables.prices.get("STECH");
    const level = sim.indexLevel("STECH") ?? 0;
    expect(row?.last).toBeCloseTo(level, 2);
    expect(row?.change).toBeCloseTo(level - INDEX_BASE, 2);
    expect(row?.bid).toBeNull();
  });
});
