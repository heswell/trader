import { describe, expect, test } from "bun:test";
import { OrdType, Side, TimeInForce } from "@heswell/trading-schemas";
import {
  EMPTY_DRAFT,
  isTimeInForceAllowed,
  nudgePrice,
  nudgeQuantity,
  type OrderDraft,
  type OrderTicketInstrument,
  parsePrice,
  parseQuantity,
  previewRisk,
  validateDraft,
} from "../src";

const instrument: OrderTicketInstrument = {
  ric: "VOD.L",
  currency: "GBX",
  exchange: "XLON",
  tickSize: 0.5,
  lotSize: 100,
  priceDecimals: 1,
  bid: 100,
  ask: 100.5,
  last: 100,
};

const accounts = [
  {
    account: "ACC1",
    enabled: true,
    maxOrderQty: 10_000,
    maxOrderNotional: 50_000,
  },
  { account: "OFF", enabled: false },
];

const draft = (overrides: Partial<OrderDraft> = {}): OrderDraft => ({
  ...EMPTY_DRAFT,
  ric: "VOD.L",
  account: "ACC1",
  side: Side.Buy,
  ordType: OrdType.Limit,
  timeInForce: TimeInForce.Day,
  quantity: "200",
  price: "100",
  ...overrides,
});

describe("orderTicketModel", () => {
  test("parses quantities and prices", () => {
    expect(parseQuantity("1,500")).toBe(1500);
    expect(parseQuantity("2k")).toBe(2000);
    expect(parseQuantity("1.5m")).toBe(1_500_000);
    expect(parseQuantity("abc")).toBeNaN();
    expect(parsePrice("")).toBeUndefined();
    expect(parsePrice("1,234.5")).toBe(1234.5);
    expect(parsePrice("x")).toBeNaN();
  });

  test("valid limit draft yields createOrder params", () => {
    const { errors, params } = validateDraft(draft(), instrument, accounts);
    expect(errors).toEqual({});
    expect(params).toMatchObject({
      account: "ACC1",
      ric: "VOD.L",
      side: Side.Buy,
      ordType: OrdType.Limit,
      quantity: 200,
      price: 100,
    });
  });

  test("lot, tick, missing fields and disabled accounts are errors", () => {
    expect(
      validateDraft(draft({ quantity: "150" }), instrument, accounts).errors
        .quantity,
    ).toBeString();
    expect(
      validateDraft(draft({ price: "100.3" }), instrument, accounts).errors
        .price,
    ).toBeString();
    expect(
      validateDraft(draft({ price: "" }), instrument, accounts).errors.price,
    ).toBe("Enter a limit price");
    expect(
      validateDraft(draft({ account: "OFF" }), instrument, accounts).errors
        .account,
    ).toContain("disabled");
    expect(
      validateDraft(draft({ ric: undefined }), instrument, accounts).errors.ric,
    ).toBeString();
    const market = validateDraft(
      draft({ ordType: OrdType.Market, price: "" }),
      instrument,
      accounts,
    );
    expect(market.errors).toEqual({});
    expect(market.params?.price).toBeUndefined();
  });

  test("nudges by tick and lot", () => {
    expect(nudgePrice(draft({ price: "100" }), instrument, 1)).toBe("100.5");
    expect(nudgePrice(draft({ price: "100" }), instrument, -2)).toBe("99.0");
    // empty price starts from the touch for the side
    expect(nudgePrice(draft({ price: "" }), instrument, 1)).toBeString();
    expect(nudgeQuantity("200", instrument, 1)).toBe("300");
    expect(nudgeQuantity("100", instrument, -5)).toBe("100");
  });

  test("time in force support by order type", () => {
    expect(
      isTimeInForceAllowed(OrdType.Limit, TimeInForce.GoodTillCancel),
    ).toBe(true);
    expect(
      isTimeInForceAllowed(OrdType.Market, TimeInForce.ImmediateOrCancel),
    ).toBe(true);
    expect(
      isTimeInForceAllowed(OrdType.Market, TimeInForce.GoodTillCancel),
    ).toBe(false);
  });

  test("risk preview: notional in pence, USD equivalent and limit warnings", () => {
    const preview = previewRisk(
      draft({ quantity: "10000" }),
      instrument,
      accounts[0],
      {
        usdPerPriceUnit: { GBX: 0.0127 },
      },
    );
    expect(preview.notional).toBe(1_000_000);
    expect(preview.currency).toBe("GBX");
    expect(preview.notionalUsd).toBeCloseTo(12_700);
    expect(preview.warnings).toEqual([]);

    const big = previewRisk(
      draft({ quantity: "20000", price: "150" }),
      instrument,
      accounts[0],
      {
        usdPerPriceUnit: { GBX: 0.0127 },
        collarPct: 0.1,
      },
    );
    const codes = big.warnings.map((w) => w.code);
    expect(codes).toContain("maxOrderQty");
    expect(codes).toContain("collar");

    const market = previewRisk(
      draft({ ordType: OrdType.Market, price: "" }),
      instrument,
      accounts[0],
    );
    expect(market.price).toBe(100.5);
  });
});
