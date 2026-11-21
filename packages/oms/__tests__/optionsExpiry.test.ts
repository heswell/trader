import { describe, expect, test } from "bun:test";
import {
  intrinsicValue,
  Liquidity,
  OrdStatus,
  PutCall,
  RejectReason,
  Side,
  TimeInForce,
} from "@heswell/trading-schemas";
import { BookSide, setup } from "./fixture";

// Thu 12 Nov 2026; the front (only) expiry is Fri 20 Nov at 16:30
const NOW = Date.UTC(2026, 10, 12, 14, 0);
const CALL = "AAPL175K6";
const PUT = "AAPL165W6";

const optionsSetup = () => {
  const t = setup({
    time: NOW,
    simConfig: { options: "AAPL.OQ", optionsExpiries: 1 },
  });
  const call = t.sim.gateway.getInstrument(CALL);
  const put = t.sim.gateway.getInstrument(PUT);
  if (!call?.expiry || !put) throw Error("no options");
  return { ...t, call, put, expiry: call.expiry };
};

describe("options expiry in the OMS", () => {
  test("positions settle in cash at intrinsic value; orders end", () => {
    const { sim, engine, rest, create, status, clock, call, put, expiry } =
      optionsSetup();
    expect(call).toMatchObject({ liquid: true, contractMultiplier: 100 });
    // long 3 calls, short 2 puts
    rest(CALL, BookSide.SELL, call.refPrice, 3);
    const bought = create({ ric: CALL, quantity: 3, price: call.refPrice });
    rest(PUT, BookSide.BUY, put.refPrice, 2);
    const sold = create({
      ric: PUT,
      side: Side.Sell,
      quantity: 2,
      price: put.refPrice,
    });
    expect(status(bought)?.status).toBe(OrdStatus.Filled);
    expect(status(sold)?.status).toBe(OrdStatus.Filled);
    const working = create({
      ric: CALL,
      quantity: 1,
      // inside the OMS's 10% collar, under the book
      price: Math.round(call.refPrice * 95) / 100,
      timeInForce: TimeInForce.GoodTillCancel,
    });
    expect(status(working)?.status).toBe(OrdStatus.New);
    expect(engine.getPosition("ACC-US-01", CALL)).toMatchObject({
      quantity: 3,
      instrumentType: "OPTION",
      underlying: "AAPL.OQ",
    });

    const spot = sim.getBook("AAPL.OQ")?.model.fairValue ?? 0;
    clock.time = expiry;
    sim.step(clock.time);

    const callSettle = sim.gateway.getInstrument(CALL)?.settlementPrice;
    const putSettle = sim.gateway.getInstrument(PUT)?.settlementPrice;
    expect(callSettle).toBeCloseTo(intrinsicValue(PutCall.Call, spot, 175), 2);
    expect(putSettle).toBeCloseTo(intrinsicValue(PutCall.Put, spot, 165), 2);
    expect(status(working)?.status).toBe(OrdStatus.Expired);

    const longCall = engine.getPosition("ACC-US-01", CALL);
    expect(longCall?.quantity).toBe(0);
    expect(longCall?.realizedPnl).toBeCloseTo(
      3 * ((callSettle ?? 0) - call.refPrice) * 100,
      6,
    );
    const shortPut = engine.getPosition("ACC-US-01", PUT);
    expect(shortPut?.quantity).toBe(0);
    expect(shortPut?.realizedPnl).toBeCloseTo(
      2 * (put.refPrice - (putSettle ?? 0)) * 100,
      6,
    );
    const settlements = engine.fills.filter(
      (f) => f.liquidity === Liquidity.Settlement,
    );
    expect(settlements).toHaveLength(2);
    expect(settlements.find((f) => f.ric === PUT)).toMatchObject({
      side: Side.Buy,
      quantity: 2,
      price: putSettle,
    });

    // the expired option takes no more orders
    const result = engine.createOrder(
      {
        account: "ACC-US-01",
        ric: CALL,
        side: Side.Buy,
        ordType: "LIMIT",
        quantity: 1,
        price: call.refPrice,
      },
      { user: "alice" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe(RejectReason.MarketClosed);
  });

  test("an out-of-the-money option settles at 0", () => {
    const { sim, engine, rest, create, clock, expiry } = optionsSetup();
    const ric = "AAPL185K6";
    const def = sim.gateway.getInstrument(ric);
    if (!def) throw Error(`no ${ric}`);
    rest(ric, BookSide.SELL, def.refPrice, 4);
    create({ ric, quantity: 4, price: def.refPrice });
    sim.getBook("AAPL.OQ")?.model.shift(-500); // ~166: the 185 call is worthless
    clock.time = expiry;
    sim.step(clock.time);
    expect(sim.gateway.getInstrument(ric)?.settlementPrice).toBe(0);
    const position = engine.getPosition("ACC-US-01", ric);
    expect(position?.quantity).toBe(0);
    expect(position?.realizedPnl).toBeCloseTo(-4 * def.refPrice * 100, 6);
  });
});
