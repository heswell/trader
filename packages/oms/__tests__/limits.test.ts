import { describe, expect, test } from "bun:test";
import {
  FIRM_ENTITY_ID,
  LimitEntityType,
  LimitMetric,
  LimitScope,
  LimitState,
  OrdType,
  limitState,
  RejectReason,
  Side,
} from "@heswell/trading-schemas";
import {
  accountLimits,
  LimitBook,
  limitBookFor,
  limitDefinition,
  limitEntities,
  orderLimits,
  orderLimitsOf,
  parseLimits,
  visibleEntities,
} from "../src/limits/LimitBook";
import { limitUtilisation } from "../src/limits/utilisation";
import { createOms } from "../src/engine/OmsService";
import { SEED_ACCOUNTS, simClientAccounts } from "../src/reference/accounts";
import { AAPL, BookSide, setup, VOD } from "./fixture";

const ACCOUNTS = [...SEED_ACCOUNTS, ...simClientAccounts(2)];

describe("limit entities", () => {
  test("Firm, then a desk per account desk, then the accounts", () => {
    const entities = limitEntities(ACCOUNTS);
    expect(entities[0]).toEqual({
      entityId: FIRM_ENTITY_ID,
      entityType: LimitEntityType.Firm,
      name: "Firm",
      parentId: "",
    });
    expect(
      entities
        .filter((e) => e.entityType === LimitEntityType.Desk)
        .map((e) => e.entityId),
    ).toEqual(["EQ-US", "EQ-EU", "EQ-ASIA", "SIM-CLIENTS"]);
    expect(entities.find((e) => e.entityId === "CLIENT-02")).toMatchObject({
      entityType: LimitEntityType.Account,
      parentId: "SIM-CLIENTS",
    });
  });

  test("ancestors run from the entity up to the Firm", () => {
    const book = limitBookFor(ACCOUNTS);
    expect(book.ancestors("ACC-EU-02").map((e) => e.entityId)).toEqual([
      "ACC-EU-02",
      "EQ-EU",
      FIRM_ENTITY_ID,
    ]);
  });
});

describe("seeded account limits", () => {
  test("from maxOrderQty, maxOrderNotional, maxPositionNotional, maxDeltaUsd", () => {
    const acc = SEED_ACCOUNTS[0];
    const limits = accountLimits(acc);
    expect(limits.map((l) => [l.metric, l.soft])).toEqual([
      [LimitMetric.OrderQty, acc.maxOrderQty],
      [LimitMetric.OrderNotional, acc.maxOrderNotional],
      [LimitMetric.PositionNotional, acc.maxPositionNotional],
      [LimitMetric.NetDelta, acc.maxDeltaUsd],
    ]);
    const qty = limits[0];
    expect(qty).toMatchObject({
      limitKey: `${acc.account}:${LimitMetric.OrderQty}`,
      scope: LimitScope.PerOrder,
      warning: acc.maxOrderQty * 0.8,
      hard: acc.maxOrderQty,
      owner: acc.owner,
      active: true,
    });
    expect(limits[2].hard).toBeCloseTo(acc.maxPositionNotional * 1.1);
  });

  test("no delta limit when maxDeltaUsd is 0", () => {
    const limits = accountLimits({ ...SEED_ACCOUNTS[0], maxDeltaUsd: 0 });
    expect(limits.map((l) => l.metric)).not.toContain(LimitMetric.NetDelta);
    expect(
      orderLimitsOf({ ...SEED_ACCOUNTS[0], maxDeltaUsd: 0 }).maxDeltaUsd,
    ).toBe(Infinity);
  });

  test("the book gives the same order limits as the account's own fields", () => {
    const book = limitBookFor(ACCOUNTS);
    for (const account of ACCOUNTS) {
      expect(orderLimits(book, account.account, AAPL, AAPL)).toEqual(
        orderLimitsOf(account),
      );
    }
  });
});

describe("effective limits", () => {
  const entities = limitEntities(SEED_ACCOUNTS);

  test("the nearest limit up the tree applies", () => {
    const book = new LimitBook(entities, [
      limitDefinition(FIRM_ENTITY_ID, LimitMetric.OrderQty, 500_000),
      limitDefinition("EQ-US", LimitMetric.OrderQty, 40_000),
      limitDefinition("ACC-US-01", LimitMetric.OrderQty, 50_000),
    ]);
    expect(book.effective("ACC-US-01", LimitMetric.OrderQty)).toMatchObject({
      entityId: "ACC-US-01",
      limit: { soft: 50_000 },
    });
    expect(book.softLimit("ACC-US-02", LimitMetric.OrderQty)).toBe(40_000);
    expect(book.softLimit("ACC-EU-01", LimitMetric.OrderQty)).toBe(500_000);
    expect(book.softLimit("ACC-EU-01", LimitMetric.OrderRate)).toBe(Infinity);
  });

  test("a RIC carve-out comes before the entity's limit for each RIC", () => {
    const book = new LimitBook(entities, [
      limitDefinition("EQ-EU", LimitMetric.PositionNotional, 5_000_000, {
        ric: "BARC.L",
      }),
      limitDefinition("ACC-EU-02", LimitMetric.PositionNotional, 3_000_000),
      limitDefinition("ACC-EU-02", LimitMetric.PositionNotional, 3_500_000, {
        ric: "BARC.L",
      }),
    ]);
    const softFor = (account: string, ric: string) =>
      book.softLimit(account, LimitMetric.PositionNotional, ric);
    expect(softFor("ACC-EU-02", "BARC.L")).toBe(3_500_000);
    expect(softFor("ACC-EU-02", VOD)).toBe(3_000_000);
    // ACC-EU-01 sets none: EQ-EU's BARC.L carve-out, and no limit elsewhere.
    expect(softFor("ACC-EU-01", "BARC.L")).toBe(5_000_000);
    expect(softFor("ACC-EU-01", VOD)).toBe(Infinity);
  });

  test("only active limits in their effective dates apply", () => {
    let now = 1_000;
    const book = new LimitBook(
      entities,
      [
        limitDefinition("EQ-US", LimitMetric.OrderQty, 40_000),
        limitDefinition("ACC-US-01", LimitMetric.OrderQty, 60_000, {
          effectiveFrom: 2_000,
          effectiveTo: 3_000,
        }),
        limitDefinition("ACC-US-02", LimitMetric.OrderQty, 1, {
          active: false,
        }),
      ],
      () => now,
    );
    expect(book.softLimit("ACC-US-01", LimitMetric.OrderQty)).toBe(40_000);
    now = 2_000;
    expect(book.softLimit("ACC-US-01", LimitMetric.OrderQty)).toBe(60_000);
    now = 3_000;
    expect(book.softLimit("ACC-US-01", LimitMetric.OrderQty)).toBe(40_000);
    expect(book.softLimit("ACC-US-02", LimitMetric.OrderQty)).toBe(40_000);
  });

  test("set replaces a limit by key, delete removes it", () => {
    const book = new LimitBook(entities, [
      limitDefinition("ACC-US-01", LimitMetric.OrderQty, 50_000),
    ]);
    book.set(limitDefinition("ACC-US-01", LimitMetric.OrderQty, 60_000));
    expect(book.limits.size).toBe(1);
    expect(book.softLimit("ACC-US-01", LimitMetric.OrderQty)).toBe(60_000);
    expect(book.delete(`ACC-US-01:${LimitMetric.OrderQty}`)).toBe(true);
    expect(book.softLimit("ACC-US-01", LimitMetric.OrderQty)).toBe(Infinity);
  });

  test("capViolations: a cap metric set above its parent's value", () => {
    const book = new LimitBook(entities, [
      limitDefinition("EQ-ASIA", LimitMetric.DailyLoss, 1_000_000),
      limitDefinition("ACC-ASIA-03", LimitMetric.DailyLoss, 1_200_000),
      limitDefinition("ACC-ASIA-02", LimitMetric.DailyLoss, 400_000),
      // Override metrics may go higher than their parent.
      limitDefinition("EQ-ASIA", LimitMetric.OrderQty, 10_000),
      limitDefinition("ACC-ASIA-01", LimitMetric.OrderQty, 200_000),
    ]);
    expect(
      book
        .capViolations()
        .map(({ limit, parent }) => [limit.entityId, parent.entityId]),
    ).toEqual([["ACC-ASIA-03", "EQ-ASIA"]]);
  });
});

test("limitState: OK, warning, soft breach, hard breach", () => {
  const limit = { warning: 80, soft: 100, hard: 110 };
  expect(limitState(79, limit)).toBe(LimitState.Ok);
  expect(limitState(80, limit)).toBe(LimitState.Warning);
  expect(limitState(100, limit)).toBe(LimitState.Warning);
  expect(limitState(101, limit)).toBe(LimitState.SoftBreach);
  expect(limitState(110, limit)).toBe(LimitState.HardBreach);
  // Per-order limits: hard at the limit.
  expect(limitState(101, { warning: 80, soft: 100, hard: 100 })).toBe(
    LimitState.HardBreach,
  );
});

describe("OmsEngine checks orders against its LimitBook", () => {
  test("a desk limit applies to an account that sets none", () => {
    const limits = limitBookFor(SEED_ACCOUNTS);
    limits.delete(`ACC-US-01:${LimitMetric.OrderQty}`);
    limits.set(limitDefinition("EQ-US", LimitMetric.OrderQty, 1_000));
    const { engine, order, ctx } = setup({ limits });
    const result = engine.createOrder(order({ quantity: 1_500 }), ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe(RejectReason.ExceedsMaxQuantity);
      expect(result.text).toContain("exceeds max 1000");
    }
    expect(engine.createOrder(order({ quantity: 900 }), ctx).ok).toBe(true);
  });

  test("a RIC carve-out applies to that RIC only", () => {
    const limits = limitBookFor(SEED_ACCOUNTS);
    limits.set(
      limitDefinition("ACC-US-01", LimitMetric.PositionNotional, 1_000, {
        ric: VOD,
      }),
    );
    const { engine, order, ctx } = setup({ limits });
    // AAPL at 170 x 10,000 = 1.7m, under ACC-US-01's 10m for each RIC.
    expect(
      engine.createOrder(order({ quantity: 10_000, price: 170 }), ctx).ok,
    ).toBe(true);
    const vod = engine.createOrder(
      order({ ric: VOD, quantity: 1_000, price: 224 }),
      ctx,
    );
    expect(vod.ok).toBe(false);
    if (!vod.ok) expect(vod.text).toContain("projected position");
  });

  test("a new order's own quantity is not also counted as working", () => {
    const limits = limitBookFor(SEED_ACCOUNTS);
    limits.set(
      limitDefinition("ACC-US-01", LimitMetric.PositionNotional, 1_500_000, {
        ric: AAPL,
      }),
    );
    const { engine, order, ctx } = setup({ limits });
    // About 1m USD at AAPL's reference price: once, not twice, so it fits.
    const ref = engine.riskContext("ACC-US-01", AAPL).instrument?.refPrice ?? 0;
    const quantity = Math.floor(1_000_000 / ref);
    const result = engine.createOrder(
      order({ ordType: OrdType.Market, price: undefined, quantity }),
      ctx,
    );
    expect(result.ok ? "" : result.text).toBe("");
  });

  test("riskContext carries the limits for the account and RIC", () => {
    const { engine } = setup();
    expect(engine.riskContext("ACC-US-02", AAPL).limits).toEqual(
      orderLimitsOf(SEED_ACCOUNTS[1]),
    );
  });
});

describe("limits on totals: gross position notional and order rate", () => {
  test("gross position notional is checked for the account, its desk and the firm", () => {
    const limits = limitBookFor(SEED_ACCOUNTS);
    // EQ-US: 150,000 USD gross across ACC-US-01 and ACC-US-02.
    limits.set(
      limitDefinition("EQ-US", LimitMetric.GrossPositionNotional, 150_000),
    );
    const { engine, order, rest, ctx } = setup({ limits });
    // ACC-US-01 buys 400 AAPL at 170: valued at the reference price (about
    // 350) before the fill, then a 68,000 USD position at 170.
    rest(AAPL, BookSide.SELL, 170, 400);
    expect(engine.createOrder(order({ quantity: 400 }), ctx).ok).toBe(true);
    expect(engine.grossPositionUsd("EQ-US")).toBeCloseTo(68_000, -2);
    expect(engine.grossPositionUsd("EQ-EU")).toBe(0);

    // ACC-US-02 buying 500 (85,000 USD) takes EQ-US over 150,000.
    const breach = engine.createOrder(
      order({ account: "ACC-US-02", quantity: 500 }),
      { user: "bob" },
    );
    expect(breach.ok).toBe(false);
    if (!breach.ok) {
      expect(breach.reason).toBe(RejectReason.ExceedsMaxGrossNotional);
      expect(breach.text).toContain("gross position notional of EQ-US");
    }
    expect(
      engine.createOrder(order({ account: "ACC-US-02", quantity: 400 }), {
        user: "bob",
      }).ok,
    ).toBe(true);
    // An EU account is not under EQ-US.
    expect(
      engine.createOrder(order({ account: "ACC-EU-01", quantity: 400 }), {
        user: "carol",
      }).ok,
    ).toBe(true);
    // Reducing a position is never blocked.
    expect(
      engine.createOrder(order({ side: Side.Sell, quantity: 100 }), ctx).ok,
    ).toBe(true);
  });

  test("order rate counts new orders over a rolling second, per entity", () => {
    const limits = limitBookFor(SEED_ACCOUNTS);
    limits.set(limitDefinition("ACC-US-01", LimitMetric.OrderRate, 3));
    limits.set(limitDefinition(FIRM_ENTITY_ID, LimitMetric.OrderRate, 5));
    const { engine, order, ctx, clock } = setup({ limits });
    for (let i = 0; i < 3; i++) {
      expect(engine.createOrder(order(), ctx).ok).toBe(true);
    }
    const fourth = engine.createOrder(order(), ctx);
    expect(fourth.ok).toBe(false);
    if (!fourth.ok) {
      expect(fourth.reason).toBe(RejectReason.ExceedsOrderRate);
      expect(fourth.text).toContain("ACC-US-01 has sent 3 orders");
    }
    // Rejected orders don't count; the firm has 3 of its 5.
    expect(engine.recentOrders(FIRM_ENTITY_ID)).toBe(3);
    const bob = { user: "bob" };
    expect(engine.createOrder(order({ account: "ACC-US-02" }), bob).ok).toBe(
      true,
    );
    expect(engine.createOrder(order({ account: "ACC-US-02" }), bob).ok).toBe(
      true,
    );
    const firm = engine.createOrder(order({ account: "ACC-US-02" }), bob);
    expect(firm.ok).toBe(false);
    if (!firm.ok) expect(firm.text).toContain("FIRM has sent 5 orders");

    clock.advance(1_000);
    expect(engine.recentOrders(FIRM_ENTITY_ID)).toBe(0);
    expect(engine.createOrder(order(), ctx).ok).toBe(true);
  });

  test("an amend is not counted as an order", () => {
    const limits = limitBookFor(SEED_ACCOUNTS);
    limits.set(limitDefinition("ACC-US-01", LimitMetric.OrderRate, 1));
    const { engine, create, ctx } = setup({ limits });
    const id = create();
    const amended = engine.amendOrder({ orderId: id, quantity: 200 }, ctx);
    expect(amended.ok).toBe(true);
  });
});

describe("limits from config", () => {
  test("parseLimits reads ENTITY:METRIC[:RIC]=value", () => {
    const limits = parseLimits(
      " FIRM:DAILY_LOSS=3000000, ACC-EU-02:POSITION_NOTIONAL:BARC.L=3500000 ,",
    );
    expect(limits.map((l) => [l.limitKey, l.soft, l.ric])).toEqual([
      [`FIRM:${LimitMetric.DailyLoss}`, 3_000_000, ""],
      [`ACC-EU-02:${LimitMetric.PositionNotional}:BARC.L`, 3_500_000, "BARC.L"],
    ]);
    expect(parseLimits("")).toEqual([]);
    expect(() => parseLimits("FIRM:NOPE=1")).toThrow("is not ENTITY:METRIC");
    expect(() => parseLimits("FIRM:DAILY_LOSS")).toThrow();
    expect(() => parseLimits("FIRM:DAILY_LOSS=0")).toThrow("above 0");
  });

  test("OmsService adds config limits to the accounts' own, and warns on an unknown entity", () => {
    const warnings: string[] = [];
    const { sim } = setup();
    const oms = createOms(sim.gateway, {
      config: {
        flowRate: 0,
        limits: "EQ-US:ORDER_QTY=1000,NOWHERE:DAILY_LOSS=1",
      },
      logger: { warn: (m) => warnings.push(String(m)), error: () => {} },
    });
    expect(oms.engine.limits.softLimit("ACC-US-02", LimitMetric.OrderQty)).toBe(
      20_000,
    );
    expect(oms.engine.limits.limits.has(`EQ-US:${LimitMetric.OrderQty}`)).toBe(
      true,
    );
    expect(warnings).toEqual(["oms.limits: no entity NOWHERE"]);
    oms.dispose();
  });
});

test("visibleEntities: the user's accounts and every entity above them", () => {
  const book = limitBookFor(SEED_ACCOUNTS);
  expect(
    [
      ...visibleEntities(book, {
        all: false,
        accounts: new Set(["ACC-US-01", "ACC-EU-02"]),
      }),
    ].sort(),
  ).toEqual(["ACC-EU-02", "ACC-US-01", "EQ-EU", "EQ-US", FIRM_ENTITY_ID]);
  expect(visibleEntities(book, { all: true, accounts: new Set() }).size).toBe(
    book.entities.size,
  );
});

describe("limitUtilisation", () => {
  const usage = (limits = limitBookFor(SEED_ACCOUNTS)) => {
    limits.set(
      limitDefinition(
        FIRM_ENTITY_ID,
        LimitMetric.GrossPositionNotional,
        1_000_000,
      ),
    );
    limits.set(limitDefinition(FIRM_ENTITY_ID, LimitMetric.DailyLoss, 10_000));
    limits.set(limitDefinition(FIRM_ENTITY_ID, LimitMetric.OrderRate, 100));
    limits.set(limitDefinition("EQ-US", LimitMetric.OrderQty, 1_000));
    const fixture = setup({ limits });
    const { engine, rest, order, ctx, clock } = fixture;
    rest(AAPL, BookSide.SELL, 170, 400);
    expect(engine.createOrder(order({ quantity: 400 }), ctx).ok).toBe(true);
    engine.markToMarket();
    const rows = () =>
      new Map(
        limitUtilisation(
          engine.limits,
          {
            positions: engine.positions.values(),
            orderPeak: (account) => engine.orderPeak(account),
            recentOrders: (entityId) => engine.recentOrders(entityId),
          },
          clock.now(),
        ).map((row) => [row.limitKey, row]),
      );
    return { ...fixture, rows };
  };

  test("totals: gross, order rate and daily loss of the entity", () => {
    const { rows } = usage();
    const r = rows();
    expect(r.get(`FIRM:${LimitMetric.GrossPositionNotional}`)).toMatchObject({
      entityType: LimitEntityType.Firm,
      used: 68_000,
      headroom: 932_000,
      utilisation: 0.068,
      state: LimitState.Ok,
    });
    expect(r.get(`FIRM:${LimitMetric.OrderRate}`)?.used).toBe(1);
    expect(r.get(`FIRM:${LimitMetric.DailyLoss}`)?.used).toBe(0);
  });

  test("per order: the largest order today of the accounts a limit applies to", () => {
    const { rows } = usage();
    const r = rows();
    // ACC-US-01 sets its own order quantity (50,000): 400 of it.
    expect(r.get(`ACC-US-01:${LimitMetric.OrderQty}`)).toMatchObject({
      used: 400,
      worst: "ACC-US-01",
      parentId: "EQ-US",
    });
    expect(r.get(`ACC-US-01:${LimitMetric.OrderNotional}`)?.used).toBe(68_000);
    // EQ-US's 1,000 applies to no account here (both set their own).
    expect(r.get(`EQ-US:${LimitMetric.OrderQty}`)?.used).toBe(0);
  });

  test("per RIC: the worst RIC, named in worst", () => {
    const { rows } = usage();
    expect(
      rows().get(`ACC-US-01:${LimitMetric.PositionNotional}`),
    ).toMatchObject({ used: 68_000, worst: AAPL });
  });

  test("states follow warning, soft and hard", () => {
    const limits = limitBookFor(SEED_ACCOUNTS);
    limits.set(limitDefinition("ACC-US-01", LimitMetric.OrderQty, 450));
    const { rows } = usage(limits);
    expect(rows().get(`ACC-US-01:${LimitMetric.OrderQty}`)).toMatchObject({
      used: 400,
      state: LimitState.Warning,
    });
  });
});
