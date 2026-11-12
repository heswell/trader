import { describe, expect, test } from "bun:test";
import {
  AlgoStrategy,
  OrdStatus,
  OrdType,
  RejectReason,
  Side,
  TimeInForce,
  TradingPhase,
} from "@heswell/trading-schemas";
import { OmsEngine } from "../src/engine/OmsEngine";
import { SEED_ACCOUNTS } from "../src/reference/accounts";
import { AAPL, BookSide, setup } from "./fixture";

/** Stop triggers run in a microtask after the trade. */
const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve));

/** setup() plus a helper that prints a bot-to-bot trade on the tape. */
const withMarket = (options: Parameters<typeof setup>[0] = {}) => {
  const t = setup(options);
  const trade = (price: number, size = 10) => {
    t.rest(AAPL, BookSide.SELL, price, size);
    t.rest(AAPL, BookSide.BUY, price, size);
  };
  trade(170); // last = 170
  const createStop = (o: Parameters<typeof t.create>[0] = {}) =>
    t.create({
      side: Side.Sell,
      ordType: OrdType.Stop,
      price: undefined,
      stopPrice: 169,
      ...o,
    });
  return { ...t, trade, createStop };
};

describe("stop orders (held by the OMS)", () => {
  test("a sell stop waits, then a trade at the stop sends a MARKET child", async () => {
    const parents: Record<string, unknown>[] = [];
    const t = withMarket({ sink: { parentOrder: (r) => parents.push(r) } });
    const id = t.createStop();
    const parent = t.engine.getOrder(id);
    expect(parent?.state.status).toBe(OrdStatus.New);
    expect(parent?.childOrderId).toBeUndefined();
    expect(t.engine.waitingStops.map((p) => p.orderId)).toEqual([id]);
    expect(parents.at(-1)).toMatchObject({
      ordType: OrdType.Stop,
      stopPrice: 169,
      triggeredAt: 0,
      status: OrdStatus.New,
    });

    t.trade(169.5);
    await tick();
    expect(t.engine.getOrder(id)?.childOrderId).toBeUndefined();

    // bid for the stop to sell into, then a trade at the stop
    t.rest(AAPL, BookSide.BUY, 168.9, 500);
    t.trade(169);
    expect(t.engine.getOrder(id)?.triggeredAt).toBeUndefined();
    await tick();
    const triggered = t.engine.getOrder(id);
    expect(triggered?.triggeredAt).toBe(t.clock.now());
    const child = t.engine.children.get(`${id}-1`);
    expect(child).toMatchObject({
      ordType: OrdType.Market,
      timeInForce: TimeInForce.Day,
    });
    expect(triggered?.state).toMatchObject({
      status: OrdStatus.Filled,
      cumQty: 100,
      avgPx: 168.9,
    });
    expect(t.engine.waitingStops).toEqual([]);
    expect(parents.at(-1)).toMatchObject({ triggeredAt: t.clock.now() });
  });

  test("a buy stop limit becomes a LIMIT child at its limit", async () => {
    const t = withMarket();
    const id = t.createStop({
      side: Side.Buy,
      ordType: OrdType.StopLimit,
      stopPrice: 171,
      price: 171.2,
      timeInForce: TimeInForce.GoodTillCancel,
    });
    t.trade(171.5); // gaps through the stop
    await tick();
    const child = t.engine.children.get(`${id}-1`);
    expect(child).toMatchObject({
      ordType: OrdType.Limit,
      timeInForce: TimeInForce.GoodTillCancel,
    });
    expect(child?.state.price).toBe(171.2);
    // rests at the exchange: the limit is below the market now
    expect(t.status(id)?.status).toBe(OrdStatus.New);
    expect(t.sim.gateway.getTopOfBook(AAPL)).toMatchObject({ bid: 171.2 });
    // it amends like a DMA order once triggered, but not its stop
    expect(
      t.engine.amendOrder({ orderId: id, stopPrice: 172 }, t.ctx),
    ).toMatchObject({ ok: false, reason: RejectReason.InvalidStopPrice });
    expect(t.engine.amendOrder({ orderId: id, price: 171.3 }, t.ctx).ok).toBe(
      true,
    );
    expect(t.status(id)?.price).toBe(171.3);
  });

  test("entry rejects: stop already reached, algo strategy, IOC", () => {
    const t = withMarket();
    const reject = (o: Parameters<typeof t.order>[0]) =>
      t.engine.createOrder(
        t.order({ ordType: OrdType.Stop, price: undefined, ...o }),
        t.ctx,
      );
    expect(reject({ side: Side.Sell, stopPrice: 170 })).toMatchObject({
      ok: false,
      reason: RejectReason.InvalidStopPrice,
    });
    expect(reject({ side: Side.Buy, stopPrice: 169 })).toMatchObject({
      ok: false,
      reason: RejectReason.InvalidStopPrice,
    });
    expect(
      reject({ stopPrice: 171, strategy: AlgoStrategy.Twap }),
    ).toMatchObject({ ok: false, reason: RejectReason.UnsupportedOrdType });
    expect(
      reject({ stopPrice: 171, timeInForce: TimeInForce.ImmediateOrCancel }),
    ).toMatchObject({ ok: false, reason: RejectReason.UnsupportedTimeInForce });
    expect(reject({ stopPrice: undefined })).toMatchObject({
      ok: false,
      reason: RejectReason.MissingStopPrice,
    });
  });

  test("amend while waiting: stop, quantity and limit change at once", async () => {
    const t = withMarket();
    const id = t.createStop({
      ordType: OrdType.StopLimit,
      stopPrice: 169,
      price: 168.8,
    });
    expect(
      t.engine.amendOrder(
        { orderId: id, stopPrice: 168.5, price: 168.4, quantity: 200 },
        t.ctx,
      ),
    ).toMatchObject({ ok: true, value: { status: OrdStatus.Replaced } });
    const parent = t.engine.getOrder(id);
    expect(parent?.stopPrice).toBe(168.5);
    expect(parent?.state).toMatchObject({
      quantity: 200,
      price: 168.4,
      leavesQty: 200,
      version: 1,
    });
    // through the market, or limit above the sell stop
    expect(
      t.engine.amendOrder({ orderId: id, stopPrice: 170.5 }, t.ctx),
    ).toMatchObject({ ok: false, reason: RejectReason.InvalidStopPrice });
    expect(
      t.engine.amendOrder({ orderId: id, price: 168.6 }, t.ctx),
    ).toMatchObject({ ok: false, reason: RejectReason.InvalidPrice });

    // the old stop no longer triggers, the new one does
    t.trade(169);
    await tick();
    expect(t.engine.getOrder(id)?.triggeredAt).toBeUndefined();
    t.trade(168.5);
    await tick();
    expect(t.engine.children.get(`${id}-1`)?.state).toMatchObject({
      quantity: 200,
      price: 168.4,
    });
  });

  test("cancel while waiting needs no exchange round trip", async () => {
    const t = withMarket();
    const id = t.createStop();
    expect(t.engine.cancelOrder({ orderId: id }, t.ctx)).toMatchObject({
      ok: true,
      value: { status: OrdStatus.Cancelled },
    });
    expect(t.engine.waitingStops).toEqual([]);
    t.trade(168);
    await tick();
    expect(t.engine.getOrder(id)?.childOrderId).toBeUndefined();
    // cancelAll reaches waiting stops too
    const id2 = t.createStop({ stopPrice: 167 });
    t.engine.cancelAll({}, t.ctx);
    expect(t.status(id2)?.status).toBe(OrdStatus.Cancelled);
  });

  test("a rejected child expires the triggered stop", async () => {
    const t = withMarket();
    const id = t.createStop();
    t.trade(169);
    // halted between the trade and the trigger: the exchange rejects the child
    t.sim.haltInstrument(AAPL);
    await tick();
    expect(t.status(id)).toMatchObject({ status: OrdStatus.Expired });
    expect(t.status(id)?.text).toMatch(
      /stop triggered but the order was rejected/,
    );
  });

  test("DAY stops expire at end of day and when the market closes; GTC stays", () => {
    const t = withMarket();
    const day = t.createStop();
    const gtc = t.createStop({ timeInForce: TimeInForce.GoodTillCancel });
    expect(t.engine.endOfDay()).toEqual([day]);
    expect(t.status(day)?.status).toBe(OrdStatus.Expired);

    const day2 = t.createStop();
    t.sim.setMarketPhase(TradingPhase.Closed);
    t.engine.stepAlgos();
    expect(t.status(day2)).toMatchObject({
      status: OrdStatus.Expired,
      text: "DAY stop expired at market close",
    });
    expect(t.status(gtc)?.status).toBe(OrdStatus.New);
  });

  test("waiting stops survive a restart", async () => {
    const t = withMarket();
    const id = t.createStop();
    const state = structuredClone(t.engine.exportState());
    t.engine.dispose();
    const engine = new OmsEngine({
      gateway: t.sim.gateway,
      accounts: SEED_ACCOUNTS,
      clock: t.clock.now,
      log: () => undefined,
    });
    engine.restoreState(state);
    engine.reconcile(t.sim.gateway);
    expect(engine.waitingStops.map((p) => p.orderId)).toEqual([id]);
    t.rest(AAPL, BookSide.BUY, 168.9, 500);
    t.trade(169);
    await tick();
    expect(engine.getOrder(id)?.state.status).toBe(OrdStatus.Filled);
  });

  test("stops cascade: one stop's fill can trigger the next", async () => {
    const t = withMarket();
    const first = t.createStop({ stopPrice: 169 });
    const second = t.createStop({ stopPrice: 168.5 });
    // thin bid below: the first stop's market sell trades down to 168.5
    t.rest(AAPL, BookSide.BUY, 168.8, 50);
    t.rest(AAPL, BookSide.BUY, 168.5, 500);
    t.trade(169);
    await tick();
    expect(t.status(first)?.status).toBe(OrdStatus.Filled);
    await tick();
    expect(t.status(second)?.status).toBe(OrdStatus.Filled);
  });
});
