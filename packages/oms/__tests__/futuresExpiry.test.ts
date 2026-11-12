import { describe, expect, test } from "bun:test";
import {
  Liquidity,
  OrdStatus,
  RejectReason,
  Side,
  TimeInForce,
} from "@heswell/trading-schemas";
import { BookSide, setup } from "./fixture";

const NOW = Date.UTC(2026, 10, 12, 9, 0);
const FUT = "AAPLZ6";

const futuresSetup = (latencyMs = 0) => {
  const t = setup({
    time: NOW,
    latencyMs,
    simConfig: { futures: "AAPL.OQ", futuresContracts: 1 },
  });
  const instrument = t.sim.gateway.getInstrument(FUT);
  if (!instrument?.expiry) throw Error(`no ${FUT}`);
  return { ...t, instrument, expiry: instrument.expiry };
};

describe("futures expiry in the OMS", () => {
  test("settles positions and ends working orders", () => {
    const { sim, engine, rest, create, status, clock, instrument, expiry } =
      futuresSetup();
    const px = instrument.refPrice;
    const tick = instrument.tickSize;
    rest(FUT, BookSide.SELL, px, 5);
    const bought = create({ ric: FUT, quantity: 5, price: px });
    expect(status(bought)?.status).toBe(OrdStatus.Filled);
    const working = create({
      ric: FUT,
      quantity: 2,
      price: px - 10 * tick,
      timeInForce: TimeInForce.GoodTillCancel,
    });
    expect(status(working)?.status).toBe(OrdStatus.New);
    const position = engine.getPosition("ACC-US-01", FUT);
    expect(position).toMatchObject({ quantity: 5, avgCost: px });
    expect(position?.instrumentType).toBe("FUTURE");
    expect(position?.underlying).toBe("AAPL.OQ");

    clock.time = expiry;
    sim.step(clock.time);

    const settlement = sim.gateway.getInstrument(FUT)?.settlementPrice ?? 0;
    expect(settlement).toBeGreaterThan(0);
    expect(status(working)?.status).toBe(OrdStatus.Expired);
    const settled = engine.getPosition("ACC-US-01", FUT);
    expect(settled?.quantity).toBe(0);
    expect(settled?.realizedPnl).toBeCloseTo(5 * (settlement - px) * 100, 6);
    const fill = engine.fills.at(-1);
    expect(fill).toMatchObject({
      ric: FUT,
      side: Side.Sell,
      quantity: 5,
      price: settlement,
      liquidity: Liquidity.Settlement,
      orderId: "",
    });
    expect(fill?.notional).toBeCloseTo(5 * settlement * 100, 6);

    // the expired contract takes no more orders; the next one is listed
    const result = engine.createOrder(
      {
        account: "ACC-US-01",
        ric: FUT,
        side: Side.Buy,
        ordType: "LIMIT",
        quantity: 1,
        price: px,
      },
      { user: "alice" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe(RejectReason.MarketClosed);
    expect(sim.isSimulated("AAPLH7")).toBe(true);
  });

  test("with gateway latency the expiry arrives after the order reports", () => {
    const {
      sim,
      engine,
      rest,
      create,
      status,
      clock,
      scheduler,
      instrument,
      expiry,
    } = futuresSetup(5);
    const px = instrument.refPrice;
    rest(FUT, BookSide.SELL, px, 3);
    const bought = create({ ric: FUT, quantity: 3, price: px });
    scheduler.advance(10);
    expect(status(bought)?.status).toBe(OrdStatus.Filled);
    clock.time = expiry;
    sim.step(clock.time);
    expect(engine.getPosition("ACC-US-01", FUT)?.quantity).toBe(3);
    scheduler.advance(10);
    expect(engine.getPosition("ACC-US-01", FUT)?.quantity).toBe(0);
  });
});
