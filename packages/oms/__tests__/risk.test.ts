import { describe, expect, test } from "bun:test";
import {
  OrdType,
  RejectReason,
  Side,
  TimeInForce,
  TradingPhase,
} from "@heswell/trading-schemas";
import { SEED_ACCOUNTS } from "../src/reference/accounts";
import {
  checkPreTradeRisk,
  expectedPrice,
  type RiskContext,
  type RiskInstrument,
  type RiskOrder,
  referencePrice,
} from "../src/risk/preTradeRisk";

const account = (id: string) => SEED_ACCOUNTS.find((a) => a.account === id);
const AAPL: RiskInstrument = {
  ric: "AAPL.OQ",
  tickSize: 0.01,
  lotSize: 1,
  currency: "USD",
  exchange: "XNAS",
  refPrice: 100,
  usdPerPriceUnit: 1,
};
const VOD: RiskInstrument = {
  ric: "VOD.L",
  tickSize: 0.1,
  lotSize: 1,
  currency: "GBX",
  exchange: "XLON",
  refPrice: 200,
  usdPerPriceUnit: 0.0127, // GBX
};

const ctx = (c: Partial<RiskContext> = {}): RiskContext => ({
  account: account("ACC-US-01"), // maxQty 50k, order 2m USD, position 10m USD
  instrument: AAPL,
  phase: TradingPhase.Continuous,
  market: { bid: 99.9, ask: 100.1, last: 100 },
  restricted: new Set(),
  collarPct: 0.1,
  positionQty: 0,
  workingBuyQty: 0,
  workingSellQty: 0,
  ...c,
});
const order = (o: Partial<RiskOrder> = {}): RiskOrder => ({
  account: "ACC-US-01",
  ric: "AAPL.OQ",
  side: Side.Buy,
  ordType: OrdType.Limit,
  quantity: 100,
  price: 100,
  timeInForce: TimeInForce.Day,
  ...o,
});
const reason = (o: Partial<RiskOrder>, c: Partial<RiskContext> = {}) =>
  checkPreTradeRisk(order(o), ctx(c))?.reason;

describe("pre-trade risk", () => {
  test("accepts a normal order", () => {
    expect(checkPreTradeRisk(order(), ctx())).toBeUndefined();
  });

  test("account checks", () => {
    expect(reason({}, { account: undefined })).toBe(
      RejectReason.UnknownAccount,
    );
    expect(reason({}, { account: account("ACC-ASIA-03") })).toBe(
      RejectReason.AccountDisabled,
    );
  });

  test("instrument, restricted list and trading phase", () => {
    expect(reason({}, { instrument: undefined })).toBe(
      RejectReason.UnknownInstrument,
    );
    expect(reason({}, { restricted: new Set(["AAPL.OQ"]) })).toBe(
      RejectReason.RestrictedInstrument,
    );
    expect(reason({}, { phase: TradingPhase.Halted })).toBe(
      RejectReason.InstrumentHalted,
    );
    expect(reason({}, { phase: TradingPhase.Closed })).toBe(
      RejectReason.MarketClosed,
    );
  });

  test("static validation (tick / lot)", () => {
    expect(reason({ price: 100.005 })).toBe(RejectReason.InvalidTickSize);
    expect(reason({ quantity: 0 })).toBe(RejectReason.InvalidQuantity);
  });

  test("maxOrderQty", () => {
    expect(
      reason(
        { quantity: 50_000, price: 10 },
        { market: { bid: 9.9, ask: 10.1, last: 10 } },
      ),
    ).toBeUndefined();
    expect(
      reason(
        { quantity: 50_001, price: 10 },
        { market: { bid: 9.9, ask: 10.1, last: 10 } },
      ),
    ).toBe(RejectReason.ExceedsMaxQuantity);
  });

  test("maxOrderNotional in USD (GBX converted)", () => {
    // 20,001 * 100 = 2,000,100 USD > 2m
    expect(reason({ quantity: 20_001 })).toBe(RejectReason.ExceedsMaxNotional);
    // market orders are priced at the far touch
    expect(
      reason({
        ordType: OrdType.Market,
        price: undefined,
        quantity: 19_990,
        timeInForce: TimeInForce.ImmediateOrCancel,
      }),
    ).toBe(RejectReason.ExceedsMaxNotional);
    // 40,000 VOD @ 200p = 101,600 USD, fine
    expect(
      reason(
        { ric: "VOD.L", quantity: 40_000, price: 200 },
        { instrument: VOD, market: { bid: 199.9, ask: 200.1, last: 200 } },
      ),
    ).toBeUndefined();
  });

  test("price collar vs last, else mid, else refPrice", () => {
    expect(reason({ price: 110 })).toBeUndefined();
    expect(reason({ price: 110.01 })).toBe(RejectReason.PriceOutsideCollar);
    expect(reason({ price: 89.99 })).toBe(RejectReason.PriceOutsideCollar);
    expect(
      reason({ price: 120 }, { market: { bid: 119, ask: 121, last: 0 } }),
    ).toBeUndefined();
    expect(reason({ price: 120 }, { market: undefined })).toBe(
      RejectReason.PriceOutsideCollar,
    );
    expect(referencePrice(AAPL, { bid: 0, ask: 0, last: 0 })).toBe(100);
    expect(
      expectedPrice({ side: Side.Sell, ordType: OrdType.Market }, AAPL, {
        bid: 99,
        ask: 101,
        last: 100,
      }),
    ).toBe(99);
  });

  test("maxPositionNotional is worst case incl. same-side working orders", () => {
    // 10m USD limit at 100 => 100k shares
    expect(
      reason({ quantity: 10_000 }, { positionQty: 90_000 }),
    ).toBeUndefined();
    expect(reason({ quantity: 10_001 }, { positionQty: 90_000 })).toBe(
      RejectReason.ExceedsMaxNotional,
    );
    expect(
      reason(
        { quantity: 10_000 },
        { positionQty: 85_000, workingBuyQty: 5_001 },
      ),
    ).toBe(RejectReason.ExceedsMaxNotional);
    // reducing orders are always allowed
    expect(
      reason({ side: Side.Sell, quantity: 10_000 }, { positionQty: 150_000 }),
    ).toBeUndefined();
  });
});
