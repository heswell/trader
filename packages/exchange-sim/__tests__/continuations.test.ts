import { describe, expect, test } from "bun:test";
import {
  InstrumentType,
  OrdType,
  RejectReason,
  Side,
  validateOrder,
} from "@heswell/trading-schemas";
import { createExchangeSimulator } from "../src/engine/ExchangeSimulator";
import {
  continuationRic,
  listContinuations,
  listFutures,
} from "../src/reference/futures";
import { ALL_INSTRUMENTS } from "../src/reference/instruments";
import { ManualClock } from "../src/util/clock";
import { createFakeTables } from "./fakeTables";

const NOW = Date.UTC(2026, 10, 12, 9, 0); // Thu 12 Nov 2026
const azn = ALL_INSTRUMENTS.find((i) => i.ric === "AZN.L");
if (!azn) throw Error("no AZN.L");

describe("continuation reference data", () => {
  test("ric is the root, c and the position", () => {
    expect(continuationRic("AZN.L", 1)).toBe("AZNc1");
    expect(continuationRic("STECH", 2)).toBe("STECHc2");
  });

  test("c1 is the nearest expiry, whatever the listing order", () => {
    const [front, next] = listFutures(ALL_INSTRUMENTS, ["AZN.L"], NOW);
    const [c1, c2] = listContinuations(azn, [next, front]);
    expect(c1).toMatchObject({
      ric: "AZNc1",
      instrumentType: InstrumentType.Continuation,
      underlying: "AZN.L",
      contract: "AZNZ6",
      expiry: front.expiry,
      contractMultiplier: front.contractMultiplier,
      tickSize: front.tickSize,
    });
    expect(c2.contract).toBe("AZNH7");
  });

  test("a continuation takes no orders and names the contract", () => {
    const [front] = listFutures(ALL_INSTRUMENTS, ["AZN.L"], NOW);
    const [c1] = listContinuations(azn, [front]);
    const reject = validateOrder(
      { side: Side.Buy, ordType: OrdType.Limit, quantity: 1, price: 4400 },
      c1,
    );
    expect(reject?.reason).toBe(RejectReason.RestrictedInstrument);
    expect(reject?.text).toMatch(/trade AZNZ6/);
  });
});

describe("ExchangeSimulator continuations", () => {
  const setup = () => {
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
    return { clock, sim, tables };
  };

  test("lists c1 and c2 with no book of their own", () => {
    const { sim, tables } = setup();
    expect(sim.gateway.getInstrument("AZNc1")?.contract).toBe("AZNZ6");
    expect(sim.gateway.getInstrument("AZNc2")?.contract).toBe("AZNH7");
    expect(sim.isSimulated("AZNc1")).toBe(false);
    expect(tables.instruments.get("AZNc1")).toMatchObject({
      instrumentType: InstrumentType.Continuation,
      underlying: "AZN.L",
      contract: "AZNZ6",
      simulated: true,
    });
  });

  test("prices mirror the contract's", () => {
    const { clock, sim, tables } = setup();
    for (let i = 0; i < 200; i++) sim.step(clock.advance(20));
    sim.flush(clock.time);
    const { ric: _, ...front } = tables.prices.get("AZNZ6") ?? {};
    const { ric, ...c1 } = tables.prices.get("AZNc1") ?? {};
    expect(ric).toBe("AZNc1");
    expect(front.bid).toBeGreaterThan(0);
    expect(c1).toEqual(front);
    expect(tables.prices.get("AZNc2")?.bid).toBe(
      tables.prices.get("AZNH7")?.bid,
    );
  });

  test("the roll repoints c1 and c2", () => {
    const { clock, sim, tables } = setup();
    for (let i = 0; i < 50; i++) sim.step(clock.advance(20));
    sim.flush(clock.time);
    const expiry = sim.gateway.getInstrument("AZNZ6")?.expiry ?? 0;
    clock.time = expiry;
    sim.step(clock.time);
    expect(sim.gateway.getInstrument("AZNc1")?.contract).toBe("AZNH7");
    expect(sim.gateway.getInstrument("AZNc2")?.contract).toBe("AZNM7");
    expect(tables.instruments.get("AZNc1")).toMatchObject({
      contract: "AZNH7",
      expiry: sim.gateway.getInstrument("AZNH7")?.expiry,
    });
    // c1 shows the old c2's last quotes straight away
    expect(tables.prices.get("AZNc1")?.bid).toBe(
      tables.prices.get("AZNH7")?.bid,
    );
    for (let i = 0; i < 200; i++) sim.step(clock.advance(20));
    sim.flush(clock.time);
    expect(tables.prices.get("AZNc2")?.bid).toBe(
      tables.prices.get("AZNM7")?.bid,
    );
    expect(tables.prices.get("AZNc2")?.bid).toBeGreaterThan(0);
    // the expired contract's closing quotes no longer reach any continuation
    expect(tables.prices.get("AZNc1")?.phase).not.toBe("CLOSED");
    expect(sim.universe.filter((i) => i.ric === "AZNc1")).toHaveLength(1);
  });
});
