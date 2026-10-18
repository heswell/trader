import { describe, expect, test } from "bun:test";
import { OrdStatus, OrdType, Side } from "@heswell/trading-schemas";
import { DEFAULT_OMS_CONFIG, loadOmsConfig } from "../src/config";
import { executionQuality, type Position } from "../src/engine/OmsEngine";
import {
  type AccountPnlHistoryRow,
  PnlHistory,
  type PnlHistoryRow,
} from "../src/engine/PnlHistory";
import { AAPL, BookSide, setup } from "./fixture";

const T0 = 1_700_000_000_000;

describe("execution quality", () => {
  const withSink = () => {
    const rows = new Map<string, Record<string, unknown>>();
    const env = setup({
      time: T0,
      sink: { parentOrder: (row) => rows.set(row.orderId as string, row) },
    });
    // 169 / 171: arrival mid 170
    env.rest(AAPL, BookSide.BUY, 169, 1_000);
    env.rest(AAPL, BookSide.SELL, 171, 1_000);
    return { ...env, rows };
  };

  test("buy filled above arrival is positive (worse) slippage", () => {
    const { create, rows, clock } = withSink();
    clock.advance(5);
    const orderId = create({
      ordType: OrdType.Market,
      price: undefined,
      quantity: 100,
    });
    expect(rows.get(orderId)).toMatchObject({
      status: OrdStatus.Filled,
      avgPx: 171,
      arrivalPrice: 170,
      slippageBps: Math.round((1 / 170) * 1e6) / 100,
      timeToFirstFill: 0,
      timeToComplete: 0,
    });
    expect(rows.get(orderId)?.slippageBps).toBeGreaterThan(0);
  });

  test("sell filled below arrival is positive (worse) slippage", () => {
    const { create, rows } = withSink();
    const orderId = create({
      side: Side.Sell,
      ordType: OrdType.Market,
      price: undefined,
      quantity: 100,
    });
    expect(rows.get(orderId)).toMatchObject({
      avgPx: 169,
      arrivalPrice: 170,
      slippageBps: 58.82,
    });
  });

  test("price improvement is negative; times run from creation", () => {
    const { create, rows, clock, rest } = withSink();
    const orderId = create({ price: 169.5, quantity: 100 });
    expect(rows.get(orderId)).toMatchObject({
      status: OrdStatus.New,
      arrivalPrice: 170,
      slippageBps: 0,
      timeToFirstFill: 0,
      timeToComplete: 0,
    });
    clock.advance(250);
    rest(AAPL, BookSide.SELL, 169.5, 40);
    expect(rows.get(orderId)).toMatchObject({
      status: OrdStatus.PartiallyFilled,
      slippageBps: -29.41,
      timeToFirstFill: 250,
      timeToComplete: 0,
    });
    clock.advance(750);
    rest(AAPL, BookSide.SELL, 169.5, 60);
    expect(rows.get(orderId)).toMatchObject({
      status: OrdStatus.Filled,
      slippageBps: -29.41,
      timeToFirstFill: 250,
      timeToComplete: 1_000,
    });
  });

  test("executionQuality: no arrival price, unfilled and restored orders", () => {
    const base = {
      side: Side.Buy,
      created: T0,
      state: { cumQty: 0, avgPx: 0 },
    };
    expect(executionQuality(base)).toEqual({
      arrivalPrice: 0,
      slippageBps: 0,
      timeToFirstFill: 0,
      timeToComplete: 0,
    });
    // pre-upgrade snapshots have no arrivalPrice
    expect(
      executionQuality({ ...base, state: { cumQty: 10, avgPx: 100 } })
        .slippageBps,
    ).toBe(0);
    expect(
      executionQuality({
        ...base,
        side: Side.Sell,
        arrivalPrice: 100,
        state: { cumQty: 10, avgPx: 101 },
      }).slippageBps,
    ).toBe(-100);
  });

  test("child orders do not carry the parent's execution fields", () => {
    const { create, engine } = withSink();
    const orderId = create({ price: 160 });
    const parent = engine.getOrder(orderId);
    expect(parent?.arrivalPrice).toBe(170);
    const child = engine.children.get(`${orderId}-1`);
    expect(child && "arrivalPrice" in child).toBe(false);
  });
});

const position = (p: Partial<Position> & Pick<Position, "account" | "ric">) =>
  ({
    id: `${p.account}|${p.ric}`,
    currency: "USD",
    exchange: "",
    sector: "",
    quantity: 0,
    boughtQty: 0,
    soldQty: 0,
    avgCost: 0,
    realizedPnl: 0,
    markPx: 0,
    marketValue: 0,
    unrealizedPnl: 0,
    totalPnl: 0,
    lastUpdate: 0,
    ...p,
  }) as Position;

describe("PnlHistory", () => {
  const history = (length = 3) => {
    const rows = new Map<string, PnlHistoryRow>();
    const totals = new Map<string, AccountPnlHistoryRow>();
    const deleted: string[] = [];
    const pnl = new PnlHistory(
      {
        pnlHistory: (row) => rows.set(row.id, row),
        accountPnlHistory: (row) => totals.set(row.id, row),
        deleteRow: (table, key) => {
          deleted.push(`${table}:${key}`);
          rows.delete(key);
          totals.delete(key);
        },
      },
      {
        intervalMs: 1_000,
        length,
        usdPerPriceUnit: (ric) => (ric === "VOD.L" ? 0.0127 : 1),
      },
    );
    return { pnl, rows, totals, deleted };
  };

  test("rows per position and USD account totals at aligned times", () => {
    const { pnl, rows, totals } = history();
    const aapl = position({
      account: "A",
      ric: "AAPL.OQ",
      quantity: 10,
      avgCost: 100,
      markPx: 110,
      marketValue: 1_100,
      unrealizedPnl: 100,
      totalPnl: 150,
      realizedPnl: 50,
    });
    const vod = position({
      account: "A",
      ric: "VOD.L",
      currency: "GBX",
      quantity: -1_000,
      avgCost: 70,
      markPx: 72,
      marketValue: -72_000,
      unrealizedPnl: -2_000,
      totalPnl: -2_000,
    });
    const flat = position({
      account: "B",
      ric: "AAPL.OQ",
      realizedPnl: 5,
      totalPnl: 5,
    });
    expect(pnl.due(T0 + 250)).toBe(true);
    expect(pnl.due(T0 + 900)).toBe(false);
    pnl.sample(T0 + 250, [aapl, vod, flat]);
    expect(rows.get(`A|VOD.L|${T0}`)).toMatchObject({
      time: T0,
      quantity: -1_000,
      marketValue: -72_000,
      grossExposure: 72_000,
      netExposure: -72_000,
      marketValueUsd: -914.4,
      totalPnlUsd: -25.4,
      currency: "GBX",
    });
    expect(totals.get(`A|${T0}`)).toMatchObject({
      positions: 2,
      realizedPnl: 50,
      unrealizedPnl: 100 - 25.4,
      totalPnl: 150 - 25.4,
      grossExposure: 1_100 + 914.4,
      netExposure: 185.6,
    });
    expect(totals.get(`B|${T0}`)).toMatchObject({ positions: 0, totalPnl: 5 });
  });

  test("unchanged positions are not resampled; rolling window deletes the oldest", () => {
    const { pnl, rows, totals, deleted } = history(2);
    const p = position({
      account: "A",
      ric: "AAPL.OQ",
      quantity: 1,
      markPx: 10,
      marketValue: 10,
    });
    pnl.sample(T0, [p]);
    pnl.sample(T0 + 1_000, [p]);
    expect([...rows.keys()]).toEqual([`A|AAPL.OQ|${T0}`]);
    expect(totals.size).toBe(2);
    for (let i = 2; i < 5; i++) {
      pnl.sample(T0 + i * 1_000, [
        { ...p, markPx: 10 + i, marketValue: 10 + i },
      ]);
    }
    expect([...rows.keys()]).toEqual([
      `A|AAPL.OQ|${T0 + 3_000}`,
      `A|AAPL.OQ|${T0 + 4_000}`,
    ]);
    expect([...totals.keys()]).toEqual([`A|${T0 + 3_000}`, `A|${T0 + 4_000}`]);
    expect(deleted).toContain(`pnlHistory:A|AAPL.OQ|${T0}`);
    expect(deleted).toContain(`accountPnlHistory:A|${T0}`);
    expect(pnl.rowCount).toBe(4);
    // a second sample in the same interval writes nothing
    pnl.sample(T0 + 4_500, [{ ...p, markPx: 99 }]);
    expect(pnl.rowCount).toBe(4);
  });
});

describe("P&L history config", () => {
  test("defaults and validation", () => {
    expect(DEFAULT_OMS_CONFIG).toMatchObject({
      pnlHistoryIntervalMs: 10_000,
      pnlHistoryLength: 180,
    });
    expect(
      loadOmsConfig(undefined, { OMS_PNL_HISTORY_INTERVAL_MS: "0" }),
    ).toMatchObject({ pnlHistoryIntervalMs: 0 });
    expect(() =>
      loadOmsConfig(undefined, { OMS_PNL_HISTORY_LENGTH: "0" }),
    ).toThrow(/pnlHistoryLength/);
    expect(() =>
      loadOmsConfig(undefined, { OMS_PNL_HISTORY_INTERVAL_MS: "-1" }),
    ).toThrow(/pnlHistoryIntervalMs/);
  });
});
