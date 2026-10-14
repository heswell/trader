import { describe, expect, test } from "bun:test";
import {
  OrdStatus,
  OrdType,
  RejectReason,
  Side,
  TimeInForce,
} from "@heswell/trading-schemas";
import { resolveAccess, TradingRole } from "../src/permissions/access";
import { SEED_ACCOUNTS } from "../src/reference/accounts";
import { AAPL, BookSide, setup, VOD } from "./fixture";

describe("OmsEngine lifecycle (real exchange-sim)", () => {
  test("resting limit: PENDING_NEW -> NEW, child routed 1:1", () => {
    const parents: Record<string, unknown>[] = [];
    const children: Record<string, unknown>[] = [];
    const { create, engine, sim } = setup({
      sink: {
        parentOrder: (r) => parents.push(r),
        childOrder: (r) => children.push(r),
      },
    });
    const id = create({ clOrdId: "T1" });
    const parent = engine.getOrder(id);
    expect(parent?.state.status).toBe(OrdStatus.New);
    expect(parents.map((r) => r.status)).toEqual([
      OrdStatus.PendingNew,
      OrdStatus.New,
    ]);
    expect(parents.at(-1)).toMatchObject({
      orderId: id,
      clOrdId: "T1",
      trader: "alice",
      account: "ACC-US-01",
      quantity: 100,
      leavesQty: 100,
      version: 0,
      currency: "USD",
    });
    const child = children.at(-1);
    expect(child).toMatchObject({
      childOrderId: `${id}-1`,
      parentOrderId: id,
      status: OrdStatus.New,
    });
    expect(child?.exchangeOrderId).toMatch(/^X\d+$/);
    expect(sim.gateway.getTopOfBook(AAPL)).toMatchObject({
      bid: 170,
      bidSize: 100,
    });
  });

  test("partial fills roll up cumQty / leavesQty / avgPx / last*, then fill", () => {
    const fills: Record<string, unknown>[] = [];
    const { create, engine, rest, status } = setup({
      sink: { fill: (f) => fills.push({ ...f }) },
    });
    rest(AAPL, BookSide.SELL, 170, 30);
    rest(AAPL, BookSide.SELL, 170.02, 50);
    const id = create({ quantity: 100, price: 170.05 });
    expect(status(id)).toMatchObject({
      status: OrdStatus.PartiallyFilled,
      cumQty: 80,
      leavesQty: 20,
      lastQty: 50,
      lastPx: 170.02,
    });
    expect(status(id)?.avgPx).toBeCloseTo((30 * 170 + 50 * 170.02) / 80, 10);
    // a bot sells into the resting remainder
    rest(AAPL, BookSide.SELL, 170.05, 25);
    expect(status(id)).toMatchObject({
      status: OrdStatus.Filled,
      cumQty: 100,
      leavesQty: 0,
      lastQty: 20,
      lastPx: 170.05,
    });
    expect(fills.map((f) => [f.quantity, f.price, f.liquidity])).toEqual([
      [30, 170, "REMOVED"],
      [50, 170.02, "REMOVED"],
      [20, 170.05, "ADDED"],
    ]);
    expect(fills[0]).toMatchObject({
      orderId: id,
      childOrderId: `${id}-1`,
      account: "ACC-US-01",
      trader: "alice",
      side: Side.Buy,
      notional: 30 * 170,
    });
    expect(engine.children.get(`${id}-1`)?.state.status).toBe(OrdStatus.Filled);
    expect(engine.getPosition("ACC-US-01", AAPL)).toMatchObject({
      id: "ACC-US-01|AAPL.OQ",
      quantity: 100,
      boughtQty: 100,
    });
  });

  test("risk rejects are recorded as REJECTED parent orders with no child", () => {
    const parents: Record<string, unknown>[] = [];
    const { engine, order, ctx } = setup({
      restrictedRics: [VOD],
      sink: { parentOrder: (r) => parents.push(r) },
    });
    const cases = [
      [
        order({ quantity: 60_000, price: 170 }),
        RejectReason.ExceedsMaxQuantity,
      ],
      [
        order({ quantity: 20_000, price: 170 }),
        RejectReason.ExceedsMaxNotional,
      ],
      [order({ price: 250 }), RejectReason.PriceOutsideCollar],
      [order({ price: 170.001 }), RejectReason.InvalidTickSize],
      [order({ ric: VOD, price: 224 }), RejectReason.RestrictedInstrument],
      [order({ account: "ACC-ASIA-03" }), RejectReason.AccountDisabled],
      [order({ account: "NOPE" }), RejectReason.UnknownAccount],
      [order({ ric: "NOPE.N" }), RejectReason.UnknownInstrument],
    ] as const;
    for (const [request, reason] of cases) {
      const result = engine.createOrder(request, ctx);
      expect(result).toMatchObject({ ok: false, reason });
      if (result.ok) continue;
      const parent = engine.getOrder(result.orderId as string);
      expect(parent?.state).toMatchObject({
        status: OrdStatus.Rejected,
        rejectReason: reason,
        leavesQty: 0,
      });
      expect(parent?.childOrderId).toBeUndefined();
      expect(parents.at(-1)).toMatchObject({
        orderId: result.orderId,
        status: OrdStatus.Rejected,
        rejectReason: reason,
      });
    }
    expect(engine.children.size).toBe(0);
  });

  test("halted instrument rejects INSTRUMENT_HALTED", () => {
    const { engine, order, ctx, sim } = setup();
    sim.haltInstrument(AAPL);
    expect(engine.createOrder(order(), ctx)).toMatchObject({
      ok: false,
      reason: RejectReason.InstrumentHalted,
    });
  });

  test("exchange rejects are returned synchronously and recorded", () => {
    // OMS collar wide enough that the exchange's 20% band rejects first
    const { engine, order, ctx } = setup({ collarPct: 0.5 });
    const result = engine.createOrder(order({ price: 230 }), ctx);
    expect(result).toMatchObject({
      ok: false,
      reason: RejectReason.PriceOutsideCollar,
    });
    if (result.ok) return;
    const parent = engine.getOrder(result.orderId as string);
    expect(parent?.state.status).toBe(OrdStatus.Rejected);
    expect(engine.children.get(`${result.orderId}-1`)?.state.status).toBe(
      OrdStatus.Rejected,
    );
  });

  test("duplicate clOrdId per trader is refused without creating an order", () => {
    const { engine, order, ctx, create } = setup();
    create({ clOrdId: "X" });
    expect(engine.createOrder(order({ clOrdId: "X" }), ctx)).toMatchObject({
      ok: false,
      reason: RejectReason.DuplicateClOrdId,
    });
    expect(engine.parents.size).toBe(1);
    // another trader may reuse it
    expect(
      engine.createOrder(order({ clOrdId: "X" }), { user: "bob" }).ok,
    ).toBe(true);
  });

  test("amend price and quantity -> REPLACED, version bumps", () => {
    const parents: Record<string, unknown>[] = [];
    const { engine, create, ctx, status, sim } = setup({
      sink: { parentOrder: (r) => parents.push(r) },
    });
    const id = create();
    const result = engine.amendOrder(
      { orderId: id, price: 170.5, quantity: 150 },
      ctx,
    );
    expect(result).toMatchObject({
      ok: true,
      value: { status: OrdStatus.Replaced },
    });
    expect(status(id)).toMatchObject({
      status: OrdStatus.Replaced,
      quantity: 150,
      price: 170.5,
      leavesQty: 150,
      version: 1,
    });
    expect(parents.map((r) => r.status).slice(-2)).toEqual([
      OrdStatus.PendingReplace,
      OrdStatus.Replaced,
    ]);
    expect(sim.gateway.getTopOfBook(AAPL)).toMatchObject({
      bid: 170.5,
      bidSize: 150,
    });
    expect(engine.amendOrder({ orderId: id, price: 170.5 }, ctx)).toMatchObject(
      { ok: false, reason: RejectReason.InvalidRequest },
    );
  });

  test("crossing amend replaces then fills", () => {
    const { engine, create, ctx, status, rest } = setup();
    rest(AAPL, BookSide.SELL, 171, 60);
    const id = create();
    engine.amendOrder({ orderId: id, price: 171 }, ctx);
    expect(status(id)).toMatchObject({
      status: OrdStatus.PartiallyFilled,
      cumQty: 60,
      leavesQty: 40,
      price: 171,
      version: 1,
    });
  });

  test("amend is risk checked and rejects leave the order unchanged", () => {
    const { engine, create, ctx, status } = setup();
    const id = create();
    expect(
      engine.amendOrder({ orderId: id, quantity: 60_000 }, ctx),
    ).toMatchObject({ ok: false, reason: RejectReason.ExceedsMaxQuantity });
    expect(
      engine.amendOrder({ orderId: id, price: 170.003 }, ctx),
    ).toMatchObject({ ok: false, reason: RejectReason.InvalidTickSize });
    expect(status(id)).toMatchObject({
      status: OrdStatus.New,
      quantity: 100,
      version: 0,
    });
  });

  test("amend down to cumQty completes the order", () => {
    const { engine, create, ctx, status, rest } = setup();
    const id = create();
    rest(AAPL, BookSide.SELL, 170, 40);
    engine.amendOrder({ orderId: id, quantity: 40 }, ctx);
    expect(status(id)).toMatchObject({
      status: OrdStatus.Filled,
      cumQty: 40,
      leavesQty: 0,
      quantity: 40,
    });
  });

  test("cancel, cancel of done orders and of unknown orders", () => {
    const { engine, create, ctx, status, rest } = setup();
    const id = create();
    rest(AAPL, BookSide.SELL, 170, 30);
    expect(engine.cancelOrder({ orderId: id }, ctx)).toMatchObject({
      ok: true,
      value: { status: OrdStatus.Cancelled },
    });
    expect(status(id)).toMatchObject({
      status: OrdStatus.Cancelled,
      cumQty: 30,
      leavesQty: 0,
    });
    expect(engine.cancelOrder({ orderId: id }, ctx)).toMatchObject({
      ok: false,
      reason: RejectReason.TooLateToCancel,
    });
    expect(engine.amendOrder({ orderId: id, price: 169 }, ctx)).toMatchObject({
      ok: false,
      reason: RejectReason.TooLateToAmend,
    });
    expect(engine.cancelOrder({ orderId: "O-999" }, ctx)).toMatchObject({
      ok: false,
      reason: RejectReason.UnknownOrder,
    });
  });

  test("IOC limit remainder expires; FOK unfillable expires; market without liquidity expires", () => {
    const { create, status, rest } = setup();
    rest(AAPL, BookSide.SELL, 170, 30);
    const ioc = create({ timeInForce: TimeInForce.ImmediateOrCancel });
    expect(status(ioc)).toMatchObject({
      status: OrdStatus.Expired,
      cumQty: 30,
      leavesQty: 0,
    });
    rest(AAPL, BookSide.SELL, 170, 30);
    const fok = create({ timeInForce: TimeInForce.FillOrKill });
    expect(status(fok)).toMatchObject({
      status: OrdStatus.Expired,
      cumQty: 0,
      rejectReason: RejectReason.FokNotFillable,
    });
    const fokOk = create({ timeInForce: TimeInForce.FillOrKill, quantity: 30 });
    expect(status(fokOk)).toMatchObject({
      status: OrdStatus.Filled,
      cumQty: 30,
    });
    const mkt = create({
      ordType: OrdType.Market,
      price: undefined,
      side: Side.Sell,
      timeInForce: TimeInForce.ImmediateOrCancel,
    });
    expect(status(mkt)).toMatchObject({
      status: OrdStatus.Expired,
      cumQty: 0,
      rejectReason: RejectReason.NoLiquidity,
    });
  });

  test("endOfDay expires working DAY orders only", () => {
    const { engine, create, status, rest } = setup();
    const day = create({ price: 169 });
    const gtc = create({ price: 168, timeInForce: TimeInForce.GoodTillCancel });
    const day2 = create({ price: 170 });
    rest(AAPL, BookSide.SELL, 170, 10);
    expect(status(day2)?.status).toBe(OrdStatus.PartiallyFilled);
    expect(engine.endOfDay().sort()).toEqual([day, day2].sort());
    expect(status(day)).toMatchObject({
      status: OrdStatus.Expired,
      text: "DAY order expired at end of day",
    });
    expect(status(day2)).toMatchObject({
      status: OrdStatus.Expired,
      cumQty: 10,
    });
    expect(status(gtc)?.status).toBe(OrdStatus.New);
  });

  test("cancelAll cancels the caller's own orders (or a visible account's)", () => {
    const { engine, create, ctx, status, order } = setup();
    const a = create();
    const b = create({ price: 172, side: Side.Sell, quantity: 10 });
    const bobs = engine.createOrder(
      order({ account: "ACC-US-02", price: 168 }),
      { user: "bob" },
    );
    if (!bobs.ok) throw Error();
    const done = engine.cancelAll({ side: Side.Buy }, ctx);
    expect(done).toEqual({ ok: true, value: { orderIds: [a] } });
    expect(status(b)?.status).toBe(OrdStatus.New);
    expect(engine.cancelAll({}, ctx)).toEqual({
      ok: true,
      value: { orderIds: [b] },
    });
    expect(status(bobs.value.orderId)?.status).toBe(OrdStatus.New);
    // supervisor-style account filter
    expect(engine.cancelAll({ account: "ACC-US-02" }, ctx)).toEqual({
      ok: true,
      value: { orderIds: [bobs.value.orderId] },
    });
  });

  test("permissions are enforced per request", () => {
    const { engine, order, create } = setup();
    const id = create();
    const access = (name: string, roles: string[]) =>
      resolveAccess({ name, authorizations: roles }, SEED_ACCOUNTS);
    const bob = { user: "bob", access: access("bob", [TradingRole.Execute]) };
    expect(engine.createOrder(order(), bob)).toMatchObject({
      ok: false,
      reason: RejectReason.PermissionDenied,
    });
    expect(engine.cancelOrder({ orderId: id }, bob)).toMatchObject({
      ok: false,
      reason: RejectReason.UnknownOrder,
    });
    const viewer = {
      user: "alice",
      access: access("alice", [TradingRole.View]),
    };
    expect(engine.createOrder(order(), viewer)).toMatchObject({
      ok: false,
      reason: RejectReason.PermissionDenied,
    });
    expect(engine.cancelOrder({ orderId: id }, viewer)).toMatchObject({
      ok: false,
      reason: RejectReason.PermissionDenied,
    });
    const sup = {
      user: "sam",
      access: access("sam", [TradingRole.Supervisor, TradingRole.Execute]),
    };
    expect(engine.cancelOrder({ orderId: id }, sup).ok).toBe(true);
  });
});

describe("OmsEngine races (gateway latency)", () => {
  const LAT = 5;

  test("requests are ORDER_PENDING until the exchange acks", () => {
    const { engine, create, ctx, scheduler, status } = setup({
      latencyMs: LAT,
    });
    const id = create();
    expect(status(id)?.status).toBe(OrdStatus.PendingNew);
    expect(engine.cancelOrder({ orderId: id }, ctx)).toMatchObject({
      ok: false,
      reason: RejectReason.OrderPending,
    });
    scheduler.drain();
    expect(status(id)?.status).toBe(OrdStatus.New);
    expect(engine.cancelOrder({ orderId: id }, ctx)).toMatchObject({
      ok: true,
      value: { status: OrdStatus.PendingCancel },
    });
    expect(engine.amendOrder({ orderId: id, price: 169 }, ctx)).toMatchObject({
      ok: false,
      reason: RejectReason.OrderPending,
    });
    scheduler.drain();
    expect(status(id)?.status).toBe(OrdStatus.Cancelled);
  });

  test("cancel loses the race to a full fill: FILLED, late reject ignored", () => {
    const { engine, create, ctx, scheduler, status, rest, log } = setup({
      latencyMs: LAT,
    });
    const id = create();
    scheduler.drain();
    engine.cancelOrder({ orderId: id }, ctx);
    rest(AAPL, BookSide.SELL, 170, 100); // fills before the cancel arrives
    scheduler.advance(LAT);
    expect(status(id)).toMatchObject({ status: OrdStatus.Filled, cumQty: 100 });
    scheduler.drain();
    expect(status(id)).toMatchObject({ status: OrdStatus.Filled, cumQty: 100 });
    expect(engine.getPosition("ACC-US-01", AAPL)?.quantity).toBe(100);
    expect(log).toEqual([]);
  });

  test("partial fill during PENDING_CANCEL then CANCELLED", () => {
    const { engine, create, ctx, scheduler, status, rest } = setup({
      latencyMs: LAT,
    });
    const id = create();
    scheduler.drain();
    engine.cancelOrder({ orderId: id }, ctx);
    rest(AAPL, BookSide.SELL, 170, 40);
    scheduler.advance(LAT);
    expect(status(id)).toMatchObject({
      status: OrdStatus.PendingCancel,
      cumQty: 40,
      leavesQty: 60,
    });
    scheduler.drain();
    expect(status(id)).toMatchObject({
      status: OrdStatus.Cancelled,
      cumQty: 40,
      leavesQty: 0,
    });
    expect(engine.fills).toHaveLength(1);
  });

  test("partial fill during PENDING_REPLACE then REPLACED on top", () => {
    const { engine, create, ctx, scheduler, status, rest } = setup({
      latencyMs: LAT,
    });
    const id = create();
    scheduler.drain();
    engine.amendOrder({ orderId: id, quantity: 80 }, ctx);
    rest(AAPL, BookSide.SELL, 170, 30);
    scheduler.advance(LAT);
    expect(status(id)).toMatchObject({
      status: OrdStatus.PendingReplace,
      cumQty: 30,
      leavesQty: 70,
    });
    scheduler.drain();
    // after a replace the status reflects the fills (PARTIALLY_FILLED)
    expect(status(id)).toMatchObject({
      status: OrdStatus.PartiallyFilled,
      quantity: 80,
      cumQty: 30,
      leavesQty: 50,
      version: 1,
    });
  });

  test("amend loses the race to a full fill: FILLED, replace reject ignored", () => {
    const { engine, create, ctx, scheduler, status, rest } = setup({
      latencyMs: LAT,
    });
    const id = create();
    scheduler.drain();
    engine.amendOrder({ orderId: id, price: 169.9 }, ctx);
    rest(AAPL, BookSide.SELL, 170, 100);
    scheduler.drain();
    expect(status(id)).toMatchObject({
      status: OrdStatus.Filled,
      cumQty: 100,
      price: 170,
      version: 0,
    });
  });

  test("amend below cumQty racing fills ends in a consistent state", () => {
    const { engine, create, ctx, scheduler, status, rest } = setup({
      latencyMs: LAT,
    });
    const id = create();
    scheduler.drain();
    engine.amendOrder({ orderId: id, quantity: 50 }, ctx);
    rest(AAPL, BookSide.SELL, 170, 70);
    scheduler.drain();
    const s = status(id);
    expect(s?.cumQty).toBe(70);
    expect(s?.leavesQty).toBe(s ? Math.max(0, s.quantity - s.cumQty) : -1);
    expect([OrdStatus.Filled, OrdStatus.PartiallyFilled]).toContain(
      s?.status as never,
    );
    expect(s?.pendingAmend).toBeUndefined();
  });
});

describe("positions", () => {
  test("fills update positions; markToMarket uses last / mid", () => {
    const positions: Record<string, unknown>[] = [];
    const { engine, create, rest, sim } = setup({
      sink: { position: (p) => positions.push({ ...p }) },
    });
    rest(AAPL, BookSide.SELL, 170, 100);
    create({ quantity: 100, price: 170 });
    rest(AAPL, BookSide.BUY, 171, 40);
    create({ side: Side.Sell, quantity: 40, price: 171 });
    const position = engine.getPosition("ACC-US-01", AAPL);
    expect(position).toMatchObject({
      quantity: 60,
      boughtQty: 100,
      soldQty: 40,
      avgCost: 170,
      realizedPnl: 40,
      currency: "USD",
    });
    // instrument static copied onto the position (groupable by sector)
    expect(positions.at(-1)).toMatchObject({
      id: "ACC-US-01|AAPL.OQ",
      quantity: 60,
      exchange: "XNAS",
      sector: "Information Technology",
    });
    expect(sim.gateway.getTopOfBook(AAPL)?.last).toBe(171);
    engine.markToMarket();
    expect(engine.getPosition("ACC-US-01", AAPL)).toMatchObject({
      markPx: 171,
      marketValue: 60 * 171,
      unrealizedPnl: 60,
      totalPnl: 100,
    });
    // unchanged mark: nothing republished
    expect(engine.markToMarket()).toBe(0);
  });
});
