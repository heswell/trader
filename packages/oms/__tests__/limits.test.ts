import { describe, expect, test } from "bun:test";
import {
  FIRM_ENTITY_ID,
  LimitEntityType,
  LimitMetric,
  LimitScope,
  LimitState,
  limitState,
  RejectReason,
} from "@heswell/trading-schemas";
import {
  accountLimits,
  LimitBook,
  limitBookFor,
  limitDefinition,
  limitEntities,
  orderLimits,
  orderLimitsOf,
} from "../src/limits/LimitBook";
import { SEED_ACCOUNTS, simClientAccounts } from "../src/reference/accounts";
import { AAPL, setup, VOD } from "./fixture";

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

  test("riskContext carries the limits for the account and RIC", () => {
    const { engine } = setup();
    expect(engine.riskContext("ACC-US-02", AAPL).limits).toEqual(
      orderLimitsOf(SEED_ACCOUNTS[1]),
    );
  });
});
