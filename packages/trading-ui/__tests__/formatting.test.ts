import { describe, expect, test } from "bun:test";
import { OrdStatus, Side } from "@heswell/trading-schemas";
import {
  directionColour,
  formatNotional,
  formatPercent,
  formatPrice,
  formatQuantity,
  orderStatusCategory,
  sideColour,
  TradingColour,
} from "../src";

describe("formatPrice", () => {
  test("uses priceDecimals when given", () => {
    expect(formatPrice(1234.5, { priceDecimals: 2 })).toBe("1,234.50");
  });
  test("follows the tick size", () => {
    expect(formatPrice(436.5, { tickSize: 0.1 })).toBe("436.5");
    expect(formatPrice(12.3456, { tickSize: 0.0001 })).toBe("12.3456");
  });
  test("follows a tick schedule band", () => {
    const schedule = [
      { from: 0, tickSize: 0.001 },
      { from: 10, tickSize: 0.01 },
      { from: 100, tickSize: 0.1 },
    ];
    expect(formatPrice(5, { tickSize: schedule })).toBe("5.000");
    expect(formatPrice(50, { tickSize: schedule })).toBe("50.00");
    expect(formatPrice(500, { tickSize: schedule })).toBe("500.0");
  });
  test("accepts instruments-table tickBands (e.g. a SelectedInstrument)", () => {
    const instrument = {
      ric: "X.L",
      tickSize: 0.5,
      tickBands: "0:0.01;10:0.5",
    };
    expect(formatPrice(5, instrument)).toBe("5.00");
    expect(formatPrice(20, instrument)).toBe("20.0");
  });
  test("blank for missing values", () => {
    expect(formatPrice(undefined)).toBe("");
    expect(formatPrice(Number.NaN)).toBe("");
  });
});

describe("quantities and amounts", () => {
  test("formatQuantity", () => {
    expect(formatQuantity(1234567)).toBe("1,234,567");
    expect(formatQuantity(1234567, { compact: true })).toBe("1.2M");
  });
  test("formatNotional", () => {
    expect(formatNotional(1234.5)).toBe("1,234.50");
    expect(formatNotional(-12.5, { signed: true, currency: "USD" })).toBe(
      "-12.50 USD",
    );
    expect(formatNotional(12.5, { signed: true })).toBe("+12.50");
  });
  test("formatPercent", () => {
    expect(formatPercent(1.256)).toBe("+1.26%");
    expect(formatPercent(-0.5, 1)).toBe("-0.5%");
    expect(formatPercent(0)).toBe("0.00%");
  });
});

describe("colours", () => {
  test("side", () => {
    expect(sideColour(Side.Buy)).toBe(TradingColour.buy);
    expect(sideColour(Side.Sell)).toBe(TradingColour.sell);
    expect(sideColour("?")).toBe(TradingColour.neutral);
    expect(TradingColour.buy).toStartWith("var(--trading-buy, var(--salt-");
  });
  test("direction", () => {
    expect(directionColour(1)).toBe(TradingColour.up);
    expect(directionColour(-1)).toBe(TradingColour.down);
    expect(directionColour(0)).toBe(TradingColour.neutral);
  });
  test("order status categories", () => {
    expect(orderStatusCategory(OrdStatus.PendingNew)).toBe("pending");
    expect(orderStatusCategory(OrdStatus.PartiallyFilled)).toBe("working");
    expect(orderStatusCategory(OrdStatus.Filled)).toBe("filled");
    expect(orderStatusCategory(OrdStatus.Rejected)).toBe("rejected");
    expect(orderStatusCategory(OrdStatus.Cancelled)).toBe("done");
  });
});
