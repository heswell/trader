import { describe, expect, test } from "bun:test";
import {
  AlgoStrategy,
  BREACH_ESCALATE_MS,
  BreachEventKind,
  BreachStatus,
  FIRM_ENTITY_ID,
  LimitMetric,
  LimitRequestStatus,
  LimitState,
  RejectReason,
} from "@heswell/trading-schemas";
import { createOms } from "../src/engine/OmsService";
import { limitBookFor, limitDefinition } from "../src/limits/LimitBook";
import {
  type KillSwitch,
  type LimitBreach,
  LimitMonitor,
  type LimitRequest,
} from "../src/limits/LimitMonitor";
import type { LimitUtilisationRow } from "../src/limits/utilisation";
import { handleLimitsRpc } from "../src/modules/oms/limitsRpc";
import { resolveAccess, TradingRole } from "../src/permissions/access";
import { SEED_ACCOUNTS } from "../src/reference/accounts";
import { AAPL, BookSide, setup } from "./fixture";

const KEY = `ACC-US-02:${LimitMetric.PositionNotional}`;
const LOSS = `ACC-US-02:${LimitMetric.DailyLoss}`;

const supervisor = resolveAccess(
  { name: "sam", authorizations: [TradingRole.Supervisor] },
  SEED_ACCOUNTS,
);
const bob = resolveAccess(
  { name: "bob", authorizations: [TradingRole.Execute] },
  SEED_ACCOUNTS,
);

/** A LimitMonitor over the seed accounts, with a fake sink and clock. */
const monitorFixture = () => {
  let now = 1_700_000_000_000;
  const book = limitBookFor(SEED_ACCOUNTS, [], () => now);
  book.set(limitDefinition("ACC-US-02", LimitMetric.DailyLoss, 1_000_000));
  const breaches = new Map<string, LimitBreach>();
  const events: { breachId: string; kind: string; text: string }[] = [];
  const requests = new Map<string, LimitRequest>();
  const kills = new Map<string, KillSwitch>();
  const limitRows: {
    limitKey: string;
    soft: number;
    temporaryUntil: number;
  }[] = [];
  const cancelled: string[][] = [];
  const monitor = new LimitMonitor({
    book,
    clock: () => now,
    escalateTo: "sam",
    cancelWorking: (accounts) => {
      cancelled.push([...accounts]);
      return accounts.map((a) => `O-${a}`);
    },
    sink: {
      limitBreach: (row) => breaches.set(row.breachId, row),
      limitBreachEvent: (row) =>
        events.push(row as { breachId: string; kind: string; text: string }),
      limitRequest: (row) => requests.set(row.requestId, row),
      killSwitch: (row) => kills.set(row.entityId, row),
      limit: (row) => limitRows.push(row as (typeof limitRows)[number]),
    },
  });
  /** A utilisation row of `limitKey` at `used`. */
  const row = (limitKey: string, used: number): LimitUtilisationRow => {
    const limit = book.inForce(limitKey);
    if (!limit) throw Error(`no limit ${limitKey}`);
    const state =
      used >= limit.hard && used > limit.soft
        ? LimitState.HardBreach
        : used > limit.soft
          ? LimitState.SoftBreach
          : used >= limit.warning
            ? LimitState.Warning
            : LimitState.Ok;
    return {
      ...limit,
      entityType: book.entities.get(limit.entityId)?.entityType ?? "",
      temporaryUntil: 0,
      parentId: book.entities.get(limit.entityId)?.parentId ?? "",
      desk: "EQ-US",
      worst: "AAPL",
      used,
      headroom: limit.soft - used,
      utilisation: used / limit.soft,
      state,
      lastUpdate: now,
    };
  };
  const at = (limitKey: string, used: number) =>
    monitor.update([row(limitKey, used)], now);
  const advance = (ms: number) => {
    now += ms;
  };
  return {
    book,
    monitor,
    breaches,
    events,
    requests,
    kills,
    limitRows,
    cancelled,
    at,
    advance,
    now: () => now,
  };
};

describe("breaches", () => {
  test("open at warning, raise severity and peak, close once acknowledged and back under", () => {
    const { monitor, breaches, events, at, advance } = monitorFixture();
    at(KEY, 1_000_000); // ACC-US-02 position limit 5m: OK
    expect(breaches.size).toBe(0);

    at(KEY, 4_200_000); // warning at 4m
    const [breach] = [...breaches.values()];
    expect(breach).toMatchObject({
      breachId: "B-1",
      severity: LimitState.Warning,
      status: BreachStatus.Open,
      atBreach: 4_200_000,
      owner: "bob",
    });
    advance(1_000);
    at(KEY, 5_400_000); // over the 5m limit
    advance(1_000);
    at(KEY, 5_100_000);
    expect(breaches.get("B-1")).toMatchObject({
      severity: LimitState.SoftBreach,
      state: LimitState.SoftBreach,
      peak: 5_400_000,
      used: 5_100_000,
    });

    const actor = { user: "bob", access: bob };
    expect(monitor.acknowledge("B-1", actor, "reducing").ok).toBe(true);
    expect(breaches.get("B-1")?.status).toBe(BreachStatus.Acknowledged);
    // back under warning, the level it opened at: closed
    at(KEY, 3_000_000);
    expect(breaches.get("B-1")).toMatchObject({
      status: BreachStatus.Closed,
      closedAt: expect.any(Number),
    });
    expect(events.map((e) => e.kind)).toEqual([
      BreachEventKind.Crossed,
      BreachEventKind.Crossed,
      BreachEventKind.Acknowledged,
      BreachEventKind.Closed,
    ]);
    expect(events[1].text).toBe("Crossed limit 5.4m");

    // a new crossing opens a new breach
    at(KEY, 4_500_000);
    expect(breaches.get("B-2")?.status).toBe(BreachStatus.Open);
  });

  test("a breach back under stays open until acknowledged, then closes at once", () => {
    const { monitor, breaches, at } = monitorFixture();
    at(KEY, 5_200_000);
    at(KEY, 1_000_000);
    expect(breaches.get("B-1")?.status).toBe(BreachStatus.Open);
    monitor.acknowledge("B-1", { user: "bob", access: bob });
    expect(breaches.get("B-1")?.status).toBe(BreachStatus.Closed);
  });

  test("escalates when not acknowledged within 5 minutes, or on Escalate", () => {
    const { breaches, events, at, advance } = monitorFixture();
    at(KEY, 5_200_000);
    advance(BREACH_ESCALATE_MS - 1);
    at(KEY, 5_200_000);
    expect(breaches.get("B-1")?.escalatedTo).toBe("");
    advance(1);
    at(KEY, 5_200_000);
    expect(breaches.get("B-1")?.escalatedTo).toBe("sam");
    expect(events.at(-1)?.text).toBe(
      "Escalated to sam: Automatic: not acknowledged within 5 minutes",
    );

    const loss = monitorFixture();
    loss.at(KEY, 4_500_000);
    expect(
      loss.monitor.escalate("B-1", { user: "bob", access: bob }, "help").ok,
    ).toBe(true);
    expect(loss.events.at(-1)?.text).toBe("Escalated to sam: help");
  });

  test("a user can only act on breaches of entities they can see", () => {
    const { monitor, at } = monitorFixture();
    at(KEY, 5_200_000);
    const carol = resolveAccess(
      { name: "carol", authorizations: [TradingRole.Execute] },
      SEED_ACCOUNTS,
    );
    const result = monitor.acknowledge("B-1", { user: "carol", access: carol });
    expect(result.ok ? "" : result.text).toBe("no breach B-1");
    expect(monitor.comment("B-1", { user: "bob", access: bob }, "ok").ok).toBe(
      true,
    );
  });
});

describe("temporary increases", () => {
  test("requested, approved by another supervisor, in force until it expires", () => {
    const { book, monitor, requests, limitRows, events, at, advance, now } =
      monitorFixture();
    at(LOSS, 1_050_000);
    const expiresAt = now() + 60_000;
    const requested = monitor.requestIncrease(
      {
        limitKey: LOSS,
        soft: 1_250_000,
        expiresAt,
        reason: "Market move on open position",
        breachId: "B-1",
      },
      { user: "bob", access: bob },
    );
    expect(requested.ok).toBe(true);
    expect(requests.get("R-1")).toMatchObject({
      status: LimitRequestStatus.Pending,
      currentSoft: 1_000_000,
      soft: 1_250_000,
      // keeps the limit's 110% hard margin
      hard: 1_375_000,
      approver: "sam",
    });

    const own = monitor.approve("R-1", { user: "bob", access: bob });
    expect(own.ok ? "" : own.reason).toBe(RejectReason.PermissionDenied);
    expect(monitor.approve("R-1", { user: "sam", access: supervisor }).ok).toBe(
      true,
    );
    expect(requests.get("R-1")?.status).toBe(LimitRequestStatus.Approved);
    expect(book.softLimit("ACC-US-02", LimitMetric.DailyLoss)).toBe(1_250_000);
    expect(limitRows.at(-1)).toMatchObject({
      limitKey: LOSS,
      soft: 1_250_000,
      temporaryUntil: expiresAt,
    });
    expect(events.map((e) => e.kind)).toContain(
      BreachEventKind.IncreaseApproved,
    );

    advance(60_000);
    at(LOSS, 1_050_000);
    expect(requests.get("R-1")?.status).toBe(LimitRequestStatus.Expired);
    expect(book.softLimit("ACC-US-02", LimitMetric.DailyLoss)).toBe(1_000_000);
    expect(limitRows.at(-1)).toMatchObject({
      soft: 1_000_000,
      temporaryUntil: 0,
    });
  });

  test("the new limit must be above the current one; withdraw is the requester's", () => {
    const { monitor, requests, now } = monitorFixture();
    const low = monitor.requestIncrease(
      { limitKey: LOSS, soft: 900_000, expiresAt: now() + 1, reason: "x" },
      { user: "bob", access: bob },
    );
    expect(low.ok ? "" : low.text).toContain("must be above");
    monitor.requestIncrease(
      { limitKey: LOSS, soft: 1_100_000, expiresAt: now() + 1, reason: "x" },
      { user: "bob", access: bob },
    );
    expect(
      monitor.withdraw("R-1", { user: "sam", access: supervisor }).ok,
    ).toBe(false);
    expect(monitor.withdraw("R-1", { user: "bob", access: bob }).ok).toBe(true);
    expect(requests.get("R-1")?.status).toBe(LimitRequestStatus.Withdrawn);
    expect(monitor.reject("R-1", { user: "sam", access: supervisor }).ok).toBe(
      false,
    );
  });
});

describe("kill switch", () => {
  test("daily loss at hard turns it on for the entity and cancels its working orders", () => {
    const { book, kills, cancelled, events, at } = monitorFixture();
    at(LOSS, 1_050_000);
    expect(kills.size).toBe(0);
    at(LOSS, 1_120_000); // hard at 1.1m
    expect(kills.get("ACC-US-02")).toMatchObject({
      active: true,
      activatedBy: "system",
      reason: "Daily loss hard breach (1.12m of 1m)",
      cancelled: 1,
      breachId: "B-1",
    });
    expect(cancelled).toEqual([["ACC-US-02"]]);
    expect(book.killedBy("ACC-US-02")).toBe("ACC-US-02");
    expect(events.at(-1)?.kind).toBe(BreachEventKind.KillSwitch);
  });

  test("an account by its trader, a desk or the firm by a supervisor; release by a supervisor", () => {
    const { book, monitor } = monitorFixture();
    const desk = monitor.kill(
      { entityId: "EQ-US", reason: "x" },
      { user: "bob", access: bob },
    );
    expect(desk.ok ? "" : desk.reason).toBe(RejectReason.PermissionDenied);
    expect(
      monitor.kill(
        { entityId: "ACC-US-02", reason: "x" },
        { user: "bob", access: bob },
      ).ok,
    ).toBe(true);
    expect(
      monitor.kill(
        { entityId: "ACC-US-02", reason: "x" },
        { user: "bob", access: bob },
      ).ok,
    ).toBe(false);
    expect(monitor.release("ACC-US-02", { user: "bob", access: bob }).ok).toBe(
      false,
    );
    expect(
      monitor.kill(
        { entityId: FIRM_ENTITY_ID, reason: "x" },
        { user: "sam", access: supervisor },
      ).ok,
    ).toBe(true);
    expect(book.killedBy("ACC-EU-01")).toBe(FIRM_ENTITY_ID);
    expect(
      monitor.release(FIRM_ENTITY_ID, { user: "sam", access: supervisor }).ok,
    ).toBe(true);
    expect(book.killedBy("ACC-EU-01")).toBeUndefined();
    expect(book.killedBy("ACC-US-02")).toBe("ACC-US-02");
  });

  test("the engine rejects new orders and amends below it, holds algo slicing, allows cancels", () => {
    const { engine, order, ctx, create, rest, clock } = setup();
    rest(AAPL, BookSide.SELL, 180, 10_000);
    const working = create({ quantity: 100, price: 160 });
    const twap = create({
      quantity: 1_000,
      price: 176,
      strategy: AlgoStrategy.Twap,
      durationMins: 10,
    });
    const children = () =>
      [...engine.children.values()].filter((c) => c.parentOrderId === twap)
        .length;
    const before = children();

    engine.limits.kill("EQ-US", "desk stop");
    const rejected = engine.createOrder(order(), ctx);
    expect(rejected.ok ? "" : rejected.reason).toBe(RejectReason.KillSwitch);
    expect(rejected.ok ? "" : rejected.text).toBe(
      "trading is stopped for EQ-US (ACC-US-01)",
    );
    const amend = engine.amendOrder({ orderId: working, price: 161 }, ctx);
    expect(amend.ok ? "" : amend.reason).toBe(RejectReason.KillSwitch);
    for (let i = 0; i < 20; i++) engine.stepAlgos(clock.advance(30_000));
    expect(children()).toBe(before);
    expect(engine.cancelOrder({ orderId: working }, ctx).ok).toBe(true);

    engine.limits.release("EQ-US");
    expect(engine.createOrder(order(), ctx).ok).toBe(true);
  });
});

describe("OmsService and the limits RPCs", () => {
  test("killSwitch cancels working orders; breaches follow utilisation", () => {
    const { sim } = setup();
    const oms = createOms(sim.gateway, {
      config: {
        flowRate: 0,
        limits: "ACC-US-01:ORDER_QTY=100",
      },
      logger: { warn: () => {}, error: () => {} },
    });
    const sam = { name: "sam", authorizations: [TradingRole.Supervisor] };
    const created = oms.engine.createOrder(
      {
        account: "ACC-US-01",
        ric: AAPL,
        side: "BUY",
        ordType: "LIMIT",
        quantity: 90,
        price: 160,
      },
      { user: "alice" },
    );
    expect(created.ok).toBe(true);
    // a 90 lot order uses 90% of a 100 limit: a warning breach
    oms.updateLimitUtilisation();
    const [breach] = [...oms.limitMonitor.breaches.values()];
    expect(breach).toMatchObject({
      limitKey: "ACC-US-01:ORDER_QTY",
      severity: LimitState.Warning,
    });

    const killed = handleLimitsRpc(
      oms,
      "killSwitch",
      { entityId: "ACC-US-01", reason: "test", cancelWorking: true },
      sam,
    );
    expect(killed).toMatchObject({
      type: "SUCCESS_RESULT",
      data: { entityId: "ACC-US-01", active: true, orderIds: ["O-1"] },
    });
    expect(
      handleLimitsRpc(
        oms,
        "releaseKillSwitch",
        { entityId: "ACC-US-01" },
        {
          name: "alice",
          authorizations: [TradingRole.Execute],
        },
      ),
    ).toMatchObject({
      type: "ERROR_RESULT",
      errorMessage: expect.stringContaining("PERMISSION_DENIED"),
    });
    expect(
      handleLimitsRpc(oms, "acknowledgeBreach", { breachId: "B-9" }, sam),
    ).toMatchObject({ errorMessage: "INVALID_REQUEST: no breach B-9" });
    oms.dispose();
  });
});
