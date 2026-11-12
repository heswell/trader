import { describe, expect, test } from "bun:test";
import {
  AlgoStrategy,
  OrdType,
  RejectReason,
  Side,
  TimeInForce,
} from "@heswell/trading-schemas";
import {
  allowedTimesInForce,
  draftFromPrefill,
  EMPTY_DRAFT,
  fieldForRejectReason,
  isStrategyAllowed,
  isTimeInForceAllowed,
  nonStopOrdType,
  nudgeStopPrice,
  nudgePrice,
  nudgeQuantity,
  type OrderDraft,
  type OrderTicketInstrument,
  parsePrice,
  parseQuantity,
  previewRisk,
  resolveQuantityInput,
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

describe("stop orders", () => {
  const stop = (overrides: Partial<OrderDraft> = {}) =>
    draft({ ordType: OrdType.Stop, price: "", stopPrice: "101", ...overrides });

  test("a STOP sends stopPrice and no price; a STOP_LIMIT sends both", () => {
    const { errors, params } = validateDraft(stop(), instrument, accounts);
    expect(errors).toEqual({});
    expect(params).toMatchObject({ ordType: OrdType.Stop, stopPrice: 101 });
    expect(params?.price).toBeUndefined();

    const stopLimit = validateDraft(
      stop({ ordType: OrdType.StopLimit, price: "101.5" }),
      instrument,
      accounts,
    );
    expect(stopLimit.errors).toEqual({});
    expect(stopLimit.params).toMatchObject({
      ordType: OrdType.StopLimit,
      stopPrice: 101,
      price: 101.5,
    });
  });

  test("other types never send a stop price", () => {
    const { params } = validateDraft(
      draft({ stopPrice: "101" }),
      instrument,
      accounts,
    );
    expect(params).toBeDefined();
    expect(params?.stopPrice).toBeUndefined();
  });

  test("stop price errors go to the stop field", () => {
    const errors = (d: OrderDraft) =>
      validateDraft(d, instrument, accounts).errors;
    expect(errors(stop({ stopPrice: "" })).stopPrice).toBe(
      "Enter a stop price",
    );
    expect(errors(stop({ stopPrice: "x" })).stopPrice).toBeString();
    expect(errors(stop({ stopPrice: "101.3" })).stopPrice).toContain("tick");
    // Already reached: a buy stop must be above the market (last 100) ...
    expect(errors(stop({ stopPrice: "100" })).stopPrice).toContain(
      "must be above the market price",
    );
    // ... and a sell stop below it.
    expect(
      errors(stop({ side: Side.Sell, stopPrice: "100.5" })).stopPrice,
    ).toContain("must be below the market price");
    expect(errors(stop({ side: Side.Sell, stopPrice: "99.5" }))).toEqual({});
    expect(fieldForRejectReason(RejectReason.MissingStopPrice)).toBe(
      "stopPrice",
    );
    expect(fieldForRejectReason(RejectReason.InvalidStopPrice)).toBe(
      "stopPrice",
    );
  });

  test("a stop limit's limit must be on the right side of the stop", () => {
    const { errors } = validateDraft(
      stop({ ordType: OrdType.StopLimit, price: "100.5" }),
      instrument,
      accounts,
    );
    expect(errors.price).toContain("below the stop price");
  });

  test("stops are DAY / GTC and DMA only", () => {
    expect(allowedTimesInForce(OrdType.Stop)).toEqual([
      TimeInForce.Day,
      TimeInForce.GoodTillCancel,
    ]);
    expect(allowedTimesInForce(OrdType.StopLimit)).toEqual([
      TimeInForce.Day,
      TimeInForce.GoodTillCancel,
    ]);
    expect(
      validateDraft(
        stop({ timeInForce: TimeInForce.ImmediateOrCancel }),
        instrument,
        accounts,
      ).errors.timeInForce,
    ).toBeString();
    expect(
      validateDraft(stop({ strategy: AlgoStrategy.Twap }), instrument, accounts)
        .errors.strategy,
    ).toBe("Stop orders are DMA only");
    expect(isStrategyAllowed(OrdType.Stop, AlgoStrategy.Dma)).toBe(true);
    expect(isStrategyAllowed(OrdType.StopLimit, AlgoStrategy.Vwap)).toBe(false);
    expect(isStrategyAllowed(OrdType.Limit, AlgoStrategy.Vwap)).toBe(true);
    expect(nonStopOrdType(OrdType.Stop)).toBe(OrdType.Market);
    expect(nonStopOrdType(OrdType.StopLimit)).toBe(OrdType.Limit);
  });

  test("an empty stop nudges from one tick beyond the market", () => {
    expect(nudgeStopPrice(stop({ stopPrice: "" }), instrument, 1)).toBe(
      "100.5",
    );
    expect(
      nudgeStopPrice(stop({ side: Side.Sell, stopPrice: "" }), instrument, -1),
    ).toBe("99.5");
    expect(nudgeStopPrice(stop({ stopPrice: "101" }), instrument, 2)).toBe(
      "102.0",
    );
  });

  test("a STOP is valued at its stop price", () => {
    const preview = previewRisk(
      stop({ quantity: "1000", stopPrice: "102" }),
      instrument,
      accounts[0],
    );
    expect(preview.price).toBe(102);
    expect(preview.notional).toBe(102_000);
  });

  test("prefill: stopPrice implies STOP (STOP_LIMIT with a price), DMA", () => {
    expect(draftFromPrefill({ instrument, stopPrice: 101 })).toMatchObject({
      ordType: OrdType.Stop,
      stopPrice: "101.0",
      price: "",
    });
    expect(
      draftFromPrefill({
        instrument,
        stopPrice: 101,
        price: 101.5,
        strategy: AlgoStrategy.Twap,
        timeInForce: TimeInForce.ImmediateOrCancel,
      }),
    ).toMatchObject({
      ordType: OrdType.StopLimit,
      stopPrice: "101.0",
      price: "101.5",
      strategy: AlgoStrategy.Dma,
      timeInForce: TimeInForce.Day,
    });
    expect(
      draftFromPrefill({ ordType: OrdType.Limit, stopPrice: 101, price: 100 })
        .stopPrice,
    ).toBe("");
  });
});

describe("futures and indices", () => {
  const future: OrderTicketInstrument = {
    ric: "AAPLZ6",
    currency: "USD",
    exchange: "XNAS",
    instrumentType: "FUTURE",
    contractMultiplier: 100,
    tickSize: 0.01,
    lotSize: 1,
    priceDecimals: 2,
    bid: 200,
    ask: 200.02,
    last: 200,
  };

  test("notional and $ quantity include the contract multiplier", () => {
    const preview = previewRisk(
      draft({ ric: "AAPLZ6", quantity: "3", price: "200" }),
      future,
      accounts[0],
      { usdPerPriceUnit: { USD: 1 } },
    );
    expect(preview.notional).toBe(60_000);
    expect(preview.notionalUsd).toBe(60_000);
    // $100k at 200 x 100 a contract: 5 contracts
    expect(resolveQuantityInput("$100k", future, 200, { USD: 1 })).toBe(5);
    expect(
      resolveQuantityInput(
        "$100k",
        { ...future, contractMultiplier: undefined },
        200,
        { USD: 1 },
      ),
    ).toBe(500);
  });

  test("an index cannot be traded", () => {
    const { errors } = validateDraft(
      draft({ ric: "STECH", quantity: "1", price: "1000" }),
      {
        ...future,
        ric: "STECH",
        instrumentType: "INDEX",
        contractMultiplier: 1,
      },
    );
    expect(errors.ric).toMatch(/STECH is an index/);
  });

  test("a continuation names the contract to trade", () => {
    const { errors } = validateDraft(
      draft({ ric: "AAPLc1", quantity: "1", price: "200" }),
      {
        ...future,
        ric: "AAPLc1",
        instrumentType: "CONTINUATION",
        contract: "AAPLZ6",
      },
    );
    expect(errors.ric).toBe("AAPLc1 is a continuation: trade AAPLZ6");
  });
});
