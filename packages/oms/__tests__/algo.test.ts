import { describe, expect, test } from "bun:test";
import {
  AlgoStrategy,
  cumulativeVolume,
  DAY_MS,
  OrdStatus,
  RejectReason,
  type SessionSchedule,
  Side,
  TimeInForce,
  TradingPhase,
  U_SHAPED_PROFILE,
  volumeProfile,
} from "@heswell/trading-schemas";
import { OmsEngine } from "../src/engine/OmsEngine";
import { type AlgoState, resolveAlgoParams } from "../src/algo/params";
import { planSlice } from "../src/algo/planSlice";
import { pov, twap, vwap } from "../src/algo/strategies";
import { SEED_ACCOUNTS } from "../src/reference/accounts";
import { AAPL, BookSide, setup } from "./fixture";

const MIN = 60_000;

/** Two-sided AAPL book (bid 174.90 / ask 175.00) with deep liquidity. */
const withBook = (options: Parameters<typeof setup>[0] = {}) => {
  const t = setup(options);
  t.rest(AAPL, BookSide.BUY, 174.9, 1_000_000);
  t.rest(AAPL, BookSide.SELL, 175, 1_000_000);
  /** Advance the clock in algo-timer steps, slicing each time. */
  const run = (ms: number, step = 250) => {
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
      t.clock.advance(step);
      t.scheduler.advance(step);
      t.engine.stepAlgos();
    }
  };
  const children = (orderId: string) =>
    [...t.engine.children.values()].filter((c) => c.parentOrderId === orderId);
  return { ...t, run, children };
};

describe("algo orders in the OMS engine", () => {
  test("TWAP works the order evenly over its window and completes", () => {
    const { create, engine, run, children, status } = withBook();
    const id = create({
      quantity: 1_000,
      price: 176,
      strategy: AlgoStrategy.Twap,
      durationMins: 10,
    });
    const parent = engine.getOrder(id);
    expect(parent?.state.status).toBe(OrdStatus.New);
    expect(parent?.strategy).toBe(AlgoStrategy.Twap);
    // A first passive slice joins the bid straight away.
    expect(children(id)).toHaveLength(1);
    expect(children(id)[0].state.price).toBe(174.9);

    run(5 * MIN);
    const half = status(id);
    expect(half?.status).toBe(OrdStatus.PartiallyFilled);
    // Within the catch-up tolerance (5% of the order) of the schedule.
    expect(half?.cumQty).toBeGreaterThanOrEqual(450);
    expect(half?.cumQty).toBeLessThanOrEqual(510);
    expect(parent?.algo?.targetQty).toBe(500);

    run(5 * MIN + 500);
    expect(status(id)?.status).toBe(OrdStatus.Filled);
    expect(status(id)?.cumQty).toBe(1_000);
    expect(parent?.algo?.phase).toBe("DONE");
    expect(engine.runningAlgos).toHaveLength(0);
    // Many children, no overfill.
    const kids = children(id);
    expect(kids.length).toBeGreaterThan(5);
    expect(kids.reduce((n, c) => n + c.state.cumQty, 0)).toBe(1_000);
    const fills = engine.fills.filter((f) => f.orderId === id);
    expect(fills.reduce((n, f) => n + f.quantity, 0)).toBe(1_000);
    expect(engine.getPosition("ACC-US-01", AAPL)?.quantity).toBe(1_000);
  });

  test("publishes strategy, window and target on the parent row", () => {
    const rows: Record<string, unknown>[] = [];
    const { create, run, clock } = withBook({
      sink: { parentOrder: (r) => rows.push(r) },
    });
    const start = clock.time;
    const id = create({
      quantity: 1_000,
      price: 176,
      strategy: AlgoStrategy.Twap,
      durationMins: 10,
    });
    run(MIN);
    const row = rows.filter((r) => r.orderId === id).at(-1);
    expect(row).toMatchObject({
      strategy: AlgoStrategy.Twap,
      algoStart: start,
      algoEnd: start + 10 * MIN,
      participationPct: 0,
      targetQty: 100,
    });
  });

  test("never trades through the limit; the remainder expires at the end time", () => {
    const { create, engine, run, children, status } = withBook();
    const id = create({
      quantity: 1_000,
      price: 174.5, // below the bid: passive at the limit, never crosses
      strategy: AlgoStrategy.Twap,
      durationMins: 2,
    });
    run(2 * MIN + 250);
    expect(status(id)?.status).toBe(OrdStatus.Expired);
    expect(status(id)?.text).toBe("algo end time reached with 1000 unfilled");
    expect(children(id).every((c) => c.state.price === 174.5)).toBe(true);
    expect(
      children(id).filter((c) => c.state.status === OrdStatus.New),
    ).toHaveLength(0);
    expect(engine.runningAlgos).toHaveLength(0);
  });

  test("cancel pulls the live children, then the parent is CANCELLED", () => {
    const { create, engine, run, children, ctx, status } = withBook();
    const id = create({
      quantity: 1_000,
      price: 176,
      strategy: AlgoStrategy.Twap,
      durationMins: 10,
    });
    run(MIN);
    const filled = status(id)?.cumQty ?? 0;
    expect(filled).toBeGreaterThan(0);
    const result = engine.cancelOrder({ orderId: id }, ctx);
    expect(result.ok).toBe(true);
    expect(status(id)?.status).toBe(OrdStatus.Cancelled);
    expect(status(id)?.cumQty).toBe(filled);
    expect(children(id).some((c) => c.state.status === OrdStatus.New)).toBe(
      false,
    );
    run(MIN);
    expect(status(id)?.cumQty).toBe(filled);
    expect(engine.cancelOrder({ orderId: id }, ctx)).toMatchObject({
      ok: false,
      reason: RejectReason.TooLateToCancel,
    });
  });

  test("with gateway latency the parent waits in PENDING_CANCEL for its children", () => {
    const { create, engine, run, ctx, status, scheduler } = withBook({
      latencyMs: 5,
    });
    const id = create({
      quantity: 1_000,
      price: 176,
      strategy: AlgoStrategy.Twap,
      durationMins: 10,
    });
    run(MIN);
    engine.cancelOrder({ orderId: id }, ctx);
    expect(status(id)?.status).toBe(OrdStatus.PendingCancel);
    // A second cancel / amend is refused while pending.
    expect(engine.cancelOrder({ orderId: id }, ctx)).toMatchObject({
      ok: false,
      reason: RejectReason.OrderPending,
    });
    scheduler.advance(20);
    expect(status(id)?.status).toBe(OrdStatus.Cancelled);
  });

  test("amend resizes the order and slicing continues on the new quantity", () => {
    const { create, engine, run, ctx, status } = withBook();
    const id = create({
      quantity: 1_000,
      price: 176,
      strategy: AlgoStrategy.Twap,
      durationMins: 10,
    });
    run(5 * MIN);
    const result = engine.amendOrder({ orderId: id, quantity: 2_000 }, ctx);
    expect(result.ok).toBe(true);
    expect(status(id)).toMatchObject({
      status: OrdStatus.PartiallyFilled,
      quantity: 2_000,
      version: 1,
    });
    expect(engine.getOrder(id)?.algo?.phase).toBe("WORKING");
    run(5 * MIN + 500);
    expect(status(id)).toMatchObject({
      status: OrdStatus.Filled,
      cumQty: 2_000,
    });
  });

  test("POV trades its share of the volume other traders do", () => {
    const { create, engine, run, rest, status } = withBook();
    const id = create({
      quantity: 1_000,
      price: 176,
      strategy: AlgoStrategy.Pov,
      participationPct: 20,
      durationMins: 60,
    });
    run(1_000);
    expect(status(id)?.cumQty).toBe(0);
    rest(AAPL, BookSide.BUY, 175, 400); // a bot lifts 400 at the ask
    run(250);
    // 20% of all volume = 400 * 0.2 / 0.8 of others' volume.
    expect(status(id)?.cumQty).toBe(100);
    expect(engine.getOrder(id)?.algo?.marketVolume).toBe(400);
  });

  test("restart: algo state is restored and the order carries on", () => {
    const t = withBook();
    const id = t.create({
      quantity: 1_000,
      price: 176,
      strategy: AlgoStrategy.Twap,
      durationMins: 10,
    });
    t.run(3 * MIN);
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
    expect(engine.runningAlgos.map((p) => p.orderId)).toEqual([id]);
    for (let i = 0; i < 7 * 4 * 60 + 4; i++) {
      t.clock.advance(250);
      engine.stepAlgos();
    }
    expect(engine.getOrder(id)?.state).toMatchObject({
      status: OrdStatus.Filled,
      cumQty: 1_000,
    });
  });

  test("DMA orders are unchanged: one child, strategy DMA", () => {
    const rows: Record<string, unknown>[] = [];
    const { create, children } = withBook({
      sink: { parentOrder: (r) => rows.push(r) },
    });
    const id = create();
    expect(children(id).map((c) => c.orderId)).toEqual([`${id}-1`]);
    expect(rows.at(-1)).toMatchObject({
      strategy: AlgoStrategy.Dma,
      algoStart: 0,
      targetQty: 100,
    });
  });

  test("request errors are refused without creating an order", () => {
    const { engine, order, ctx } = withBook();
    const refused = [
      {
        strategy: AlgoStrategy.Twap,
        timeInForce: TimeInForce.ImmediateOrCancel,
      },
      { strategy: AlgoStrategy.Pov },
      { strategy: AlgoStrategy.Twap, durationMins: 5, endTime: "12:00" },
      { strategy: AlgoStrategy.Twap, endTime: "noon" },
      { strategy: AlgoStrategy.Vwap }, // no session close to run to
    ] as const;
    for (const params of refused) {
      const result = engine.createOrder(order(params), ctx);
      expect(result.ok).toBe(false);
      expect(result.ok ? undefined : result.orderId).toBeUndefined();
    }
    expect(engine.parents.size).toBe(0);
  });
});

// ---------------------------------------------------------------- pure parts

const day = (dayMs = DAY_MS): SessionSchedule => ({
  scheduled: true,
  dayMs,
  openAt: (8 * 60 * MIN * dayMs) / DAY_MS,
  closeAt: (16.5 * 60 * MIN * dayMs) / DAY_MS,
  profile: U_SHAPED_PROFILE,
});
const MIDNIGHT = Date.UTC(2026, 10, 3);
const at = (hours: number, dayMs = DAY_MS) =>
  MIDNIGHT + (hours * 60 * MIN * dayMs) / DAY_MS;

describe("volume curve", () => {
  test("cumulative share runs 0 -> 1 and the profile averages 1", () => {
    const p = U_SHAPED_PROFILE;
    expect(cumulativeVolume(0, p)).toBe(0);
    expect(cumulativeVolume(1, p)).toBeCloseTo(1, 10);
    let mean = 0;
    let last = -1;
    for (let i = 0; i < 1_000; i++) {
      const f = (i + 0.5) / 1_000;
      mean += volumeProfile(f, p) / 1_000;
      const c = cumulativeVolume(f, p);
      expect(c).toBeGreaterThan(last);
      last = c;
    }
    expect(mean).toBeCloseTo(1, 3);
    // Busy at the ends, quiet in the middle; busiest into the close.
    expect(volumeProfile(0.01, p)).toBeGreaterThan(3 * volumeProfile(0.5, p));
    expect(volumeProfile(0.99, p)).toBeGreaterThan(volumeProfile(0.01, p));
  });
});

describe("resolveAlgoParams", () => {
  const request = (extra: object) => ({
    account: "A",
    ric: AAPL,
    side: Side.Buy,
    ordType: "LIMIT" as const,
    quantity: 100,
    price: 1,
    ...extra,
  });

  test("VWAP runs to the close by default", () => {
    const s = day();
    const r = resolveAlgoParams(request({ strategy: "VWAP" }), s, at(10));
    expect(r).toMatchObject({
      ok: true,
      algo: { startAt: at(10), endAt: at(16.5) },
    });
  });

  test("durations are session minutes, scaled for a compressed day", () => {
    const dayMs = 2_400_000; // 40 minutes of clock per simulated day
    const s = day(dayMs);
    const r = resolveAlgoParams(
      request({ strategy: "TWAP", durationMins: 36 }),
      s,
      at(10, dayMs),
    );
    // 36 session minutes = 36 * 60_000 * dayMs / DAY_MS clock ms
    expect(r.ok && r.algo.endAt - r.algo.startAt).toBe(60_000);
  });

  test("created while closed: starts at the next open; DAY orders stop at the close", () => {
    const s = day();
    const r = resolveAlgoParams(
      request({ strategy: "TWAP", durationMins: 600 }),
      s,
      at(6),
    );
    expect(r).toMatchObject({
      ok: true,
      algo: { startAt: at(8), endAt: at(16.5) },
    });
    const gtc = resolveAlgoParams(
      request({ strategy: "TWAP", durationMins: 600, timeInForce: "GTC" }),
      s,
      at(6),
    );
    expect(gtc.ok && gtc.algo.endAt).toBe(at(18));
  });

  test("endTime is a session time of day", () => {
    const r = resolveAlgoParams(
      request({ strategy: "TWAP", endTime: "12:30" }),
      day(),
      at(10),
    );
    expect(r.ok && r.algo.endAt).toBe(at(12.5));
  });
});

describe("slice strategies", () => {
  const algo = (extra: Partial<AlgoState> = {}): AlgoState => ({
    startAt: at(8),
    endAt: at(16.5),
    participation: 0,
    phase: "WORKING",
    marketVolume: 0,
    targetQty: 0,
    ...extra,
  });

  test("VWAP front-loads against TWAP at the open and ends on the full quantity", () => {
    const ctx = { algo: algo(), quantity: 10_000, schedule: day() };
    const early = at(8 + 8.5 * 0.1);
    expect(vwap.targetQty(ctx, at(8))).toBe(0);
    expect(vwap.targetQty(ctx, early)).toBeGreaterThan(
      twap.targetQty(ctx, early),
    );
    expect(vwap.targetQty(ctx, at(16.5))).toBeCloseTo(10_000, 6);
  });

  test("VWAP over an unscheduled market is TWAP", () => {
    const ctx = {
      algo: algo({ startAt: 0, endAt: 1_000 }),
      quantity: 1_000,
      schedule: { ...day(), scheduled: false },
    };
    expect(vwap.targetQty(ctx, 250)).toBe(250);
  });

  test("POV target is participation of total volume, capped at the order", () => {
    const ctx = (marketVolume: number) => ({
      algo: algo({ participation: 0.25, marketVolume }),
      quantity: 1_000,
      schedule: day(),
    });
    expect(pov.targetQty(ctx(300), 0)).toBe(100);
    expect(pov.targetQty(ctx(1_000_000), 0)).toBe(1_000);
  });
});

describe("planSlice", () => {
  const top = {
    ric: AAPL,
    bid: 99,
    bidSize: 1,
    ask: 100,
    askSize: 1,
    last: 100,
    phase: TradingPhase.Continuous,
    seq: 1,
  };
  const base = {
    now: 10_000,
    sliceMs: 250,
    side: Side.Buy,
    limit: 0,
    lotSize: 10,
    quantity: 1_000,
    cumQty: 0,
    target: 0,
    ahead: 20,
    top,
    children: [],
  };

  test("joins the near touch with the next slice", () => {
    expect(planSlice(base)).toEqual({
      cancel: [],
      send: { quantity: 20, price: 99, timeInForce: TimeInForce.Day },
    });
  });

  test("crosses with an IOC when behind, cancelling resting children", () => {
    const child = {
      orderId: "C1",
      price: 99,
      leavesQty: 20,
      status: OrdStatus.New,
      created: 0,
    };
    const plan = planSlice({ ...base, target: 200, children: [child] });
    expect(plan.cancel).toEqual(["C1"]);
    expect(plan.send).toEqual({
      quantity: 200,
      price: 100,
      timeInForce: TimeInForce.ImmediateOrCancel,
    });
  });

  test("never exceeds the order with filled + working", () => {
    const child = {
      orderId: "C1",
      price: 99,
      leavesQty: 50,
      status: OrdStatus.PendingCancel,
      created: 0,
    };
    const plan = planSlice({
      ...base,
      cumQty: 900,
      target: 1_000,
      ahead: 1_000,
      children: [child],
    });
    expect(plan.send?.quantity).toBe(50);
  });

  test("does nothing outside continuous trading", () => {
    expect(
      planSlice({ ...base, top: { ...top, phase: TradingPhase.PreOpen } }),
    ).toEqual({ cancel: [] });
  });
});
