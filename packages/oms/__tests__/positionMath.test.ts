import { describe, expect, test } from "bun:test";
import { Side } from "@heswell/trading-schemas";
import {
  applyFill,
  FLAT_POSITION,
  markPosition,
} from "../src/domain/positionMath";

describe("position math (average cost)", () => {
  test("opening and adding re-averages cost", () => {
    const p1 = applyFill(FLAT_POSITION, Side.Buy, 100, 10);
    const p2 = applyFill(p1, Side.Buy, 100, 12);
    expect(p2).toMatchObject({
      quantity: 200,
      boughtQty: 200,
      soldQty: 0,
      avgCost: 11,
      realizedPnl: 0,
    });
  });

  test("reducing a long realises P&L and keeps avgCost", () => {
    const p = applyFill(
      applyFill(FLAT_POSITION, Side.Buy, 200, 11),
      Side.Sell,
      50,
      13,
    );
    expect(p).toMatchObject({
      quantity: 150,
      soldQty: 50,
      avgCost: 11,
      realizedPnl: 100,
    });
  });

  test("short positions realise inverted P&L", () => {
    const short = applyFill(FLAT_POSITION, Side.Sell, 100, 20);
    expect(short).toMatchObject({ quantity: -100, avgCost: 20 });
    const covered = applyFill(short, Side.Buy, 40, 18);
    expect(covered).toMatchObject({
      quantity: -60,
      avgCost: 20,
      realizedPnl: 80,
    });
  });

  test("flipping through flat opens the remainder at the fill price", () => {
    const flip = applyFill(
      applyFill(FLAT_POSITION, Side.Buy, 100, 10),
      Side.Sell,
      150,
      12,
    );
    expect(flip).toMatchObject({
      quantity: -50,
      avgCost: 12,
      realizedPnl: 200,
      boughtQty: 100,
      soldQty: 150,
    });
  });

  test("flat after closing has zero avgCost", () => {
    const flat = applyFill(
      applyFill(FLAT_POSITION, Side.Buy, 100, 10),
      Side.Sell,
      100,
      9,
    );
    expect(flat).toMatchObject({ quantity: 0, avgCost: 0, realizedPnl: -100 });
  });

  test("mark to market", () => {
    const long = applyFill(FLAT_POSITION, Side.Buy, 100, 10);
    expect(markPosition(long, 10.5)).toEqual({
      markPx: 10.5,
      marketValue: 1050,
      unrealizedPnl: 50,
      totalPnl: 50,
    });
    const short = applyFill(
      applyFill(FLAT_POSITION, Side.Sell, 100, 20),
      Side.Buy,
      40,
      18,
    );
    expect(markPosition(short, 19)).toEqual({
      markPx: 19,
      marketValue: -1140,
      unrealizedPnl: 60,
      totalPnl: 140,
    });
  });
});
