import { describe, expect, test } from "bun:test";
import { createExchangeSimulator, ManualClock } from "@heswell/exchange-sim";
import {
  OrdStatus,
  OrdType,
  RejectReason,
  Side,
  TimeInForce,
  TradingPhase,
} from "@heswell/trading-schemas";
import { OmsEngine } from "../src/engine/OmsEngine";
import { SEED_ACCOUNTS } from "../src/reference/accounts";
import { AAPL } from "./fixture";

const at = (hh: number, mm = 0) =>
  Date.UTC(2026, 0, 5) + hh * 3_600_000 + mm * 60_000;

/** exchange-sim with a scheduled session (08:00-16:30 UTC) + OmsEngine. */
const sessionSetup = (start: number) => {
  const clock = new ManualClock(start);
  const sim = createExchangeSimulator({
    clock: clock.now,
    config: {
      instruments: AAPL,
      mmRate: 0,
      takerRate: 0,
      sessionOpen: "08:00",
      sessionClose: "16:30",
    },
  });
  const engine = new OmsEngine({
    gateway: sim.gateway,
    accounts: SEED_ACCOUNTS,
    clock: clock.now,
    log: () => {},
  });
  const ctx = { user: "alice" };
  const create = (timeInForce: TimeInForce = TimeInForce.Day, price = 170) =>
    engine.createOrder(
      {
        account: "ACC-US-01",
        ric: AAPL,
        side: Side.Buy,
        ordType: OrdType.Limit,
        quantity: 100,
        price,
        timeInForce,
      },
      ctx,
    );
  const orderId = (result: ReturnType<typeof create>) => {
    if (!result.ok) throw Error(`${result.reason}: ${result.text}`);
    return result.value.orderId;
  };
  const status = (id: string) => engine.getOrder(id)?.state;
  const runTo = (until: number) => {
    while (clock.time < until) sim.step(clock.advance(60_000));
  };
  return { clock, sim, engine, create, orderId, status, runTo };
};

describe("OMS with an exchange trading session", () => {
  test("DAY orders expire at the exchange close; GTC keep working", () => {
    const { create, orderId, status, runTo } = sessionSetup(at(16));
    const day = orderId(create());
    const gtc = orderId(create(TimeInForce.GoodTillCancel, 169));
    expect(status(day)?.status).toBe(OrdStatus.New);
    runTo(at(16, 30));
    expect(status(day)).toMatchObject({
      status: OrdStatus.Expired,
      leavesQty: 0,
      text: "DAY order expired at market close",
    });
    expect(status(gtc)?.status).toBe(OrdStatus.New);
  });

  test("orders are rejected MARKET_CLOSED while the exchange is closed", () => {
    const { sim, create } = sessionSetup(at(20));
    expect(sim.marketPhase).toBe(TradingPhase.Closed);
    const result = create();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe(RejectReason.MarketClosed);
  });

  test("endOfDay still expires DAY orders before the scheduled close", () => {
    const { engine, create, orderId, status, runTo } = sessionSetup(at(12));
    const day = orderId(create());
    expect(engine.endOfDay()).toEqual([day]);
    expect(status(day)).toMatchObject({
      status: OrdStatus.Expired,
      text: "DAY order expired at end of day",
    });
    // the exchange close later finds nothing left to expire
    runTo(at(16, 30));
    expect(status(day)?.status).toBe(OrdStatus.Expired);
    expect(engine.endOfDay()).toEqual([]);
  });
});
