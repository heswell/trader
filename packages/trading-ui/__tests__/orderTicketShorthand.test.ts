import { describe, expect, test } from "bun:test";
import {
  AlgoStrategy,
  algoStrategyDefinition,
  OrdType,
  Side,
  TimeInForce,
  TradingPhase,
} from "@heswell/trading-schemas";
import {
  allowedTimesInForce,
  describePriceShorthand,
  EMPTY_DRAFT,
  filterStrategies,
  isOrderLine,
  type OrderDraft,
  type OrderTicketInstrument,
  parseAlgoParam,
  parseDurationInput,
  parseOrderLine,
  parsePercentInput,
  parseTimeInput,
  previewRisk,
  resolvePriceInput,
  resolveQuantityInput,
  reviewReasons,
  scheduleSummary,
} from "../src";

const instrument: OrderTicketInstrument = {
  ric: "VOD.L",
  currency: "GBX",
  exchange: "XLON",
  tickSize: 0.5,
  lotSize: 100,
  priceDecimals: 1,
  bid: 100,
  ask: 101,
  last: 100,
};

const draft = (overrides: Partial<OrderDraft> = {}): OrderDraft => ({
  ...EMPTY_DRAFT,
  ric: "VOD.L",
  account: "ACC1",
  side: Side.Buy,
  ordType: OrdType.Limit,
  timeInForce: TimeInForce.Day,
  quantity: "1000",
  price: "100",
  ...overrides,
});

describe("price shorthand", () => {
  test("b / a / m from the touch, with tick offsets", () => {
    expect(resolvePriceInput("b", instrument)).toBe(100);
    expect(resolvePriceInput("ask", instrument)).toBe(101);
    expect(resolvePriceInput("m", instrument)).toBe(100.5);
    expect(resolvePriceInput("b+2", instrument)).toBe(101);
    expect(resolvePriceInput("a-1", instrument)).toBe(100.5);
    expect(resolvePriceInput("99.5", instrument)).toBe(99.5);
    expect(resolvePriceInput("", instrument)).toBeUndefined();
  });

  test("NaN without a touch or for junk", () => {
    expect(resolvePriceInput("b", { ...instrument, bid: undefined })).toBeNaN();
    expect(resolvePriceInput("x", instrument)).toBeNaN();
  });

  test("describes shorthand for the hint", () => {
    expect(describePriceShorthand("b+2")).toBe("Bid +2");
    expect(describePriceShorthand("m")).toBe("Mid");
    expect(describePriceShorthand("100")).toBeUndefined();
  });
});

describe("quantity shorthand", () => {
  test("k / m suffixes", () => {
    expect(resolveQuantityInput("10k", instrument, 100)).toBe(10_000);
    expect(resolveQuantityInput("1.5m", instrument, 100)).toBe(1_500_000);
    expect(resolveQuantityInput("1,000", instrument, 100)).toBe(1_000);
  });

  test("a USD value converts at the price and rounds to the lot", () => {
    const qty = resolveQuantityInput("$250k", instrument, 100, { GBX: 0.0125 });
    // 250,000 / (100 × 0.0125) = 200,000 shares
    expect(qty).toBe(200_000);
    expect(resolveQuantityInput("$1", instrument, 100, { GBX: 0.0125 })).toBe(
      100,
    );
    expect(resolveQuantityInput("$250k", instrument, undefined)).toBeNaN();
  });
});

describe("algo parameter input", () => {
  test("durations", () => {
    expect(parseDurationInput("45")).toBe(45);
    expect(parseDurationInput("45m")).toBe(45);
    expect(parseDurationInput("1h")).toBe(60);
    expect(parseDurationInput("1h30")).toBe(90);
    expect(parseDurationInput("")).toBeUndefined();
    expect(parseDurationInput("soon")).toBeNaN();
  });

  test("times", () => {
    expect(parseTimeInput("15:30")).toBe("15:30");
    expect(parseTimeInput("1530")).toBe("15:30");
    expect(parseTimeInput("930")).toBe("09:30");
    expect(parseTimeInput("close")).toBeUndefined();
    expect(parseTimeInput("25:00")).toBeNull();
  });

  test("percent", () => {
    expect(parsePercentInput("10%")).toBe(10);
    expect(parsePercentInput("10")).toBe(10);
    expect(parsePercentInput("")).toBeUndefined();
  });

  test("validated against the definition", () => {
    const [participation] = algoStrategyDefinition(AlgoStrategy.Pov).params;
    expect(parseAlgoParam(participation, "10%")).toEqual({ value: 10 });
    expect(parseAlgoParam(participation, "")).toEqual({
      error: "Enter participation",
    });
    expect(parseAlgoParam(participation, "80").error).toBe(
      "Participation must be 1 to 50%",
    );
  });
});

describe("strategy picker", () => {
  test("filters by name, id or description in group order", () => {
    expect(filterStrategies().map((d) => d.id)).toEqual([
      AlgoStrategy.Dma,
      AlgoStrategy.Twap,
      AlgoStrategy.Vwap,
      AlgoStrategy.Pov,
    ]);
    expect(filterStrategies("wap").map((d) => d.id)).toEqual([
      AlgoStrategy.Twap,
      AlgoStrategy.Vwap,
    ]);
    expect(filterStrategies("volume").map((d) => d.id)).toEqual([
      AlgoStrategy.Vwap,
      AlgoStrategy.Pov,
    ]);
  });
});

describe("time in force", () => {
  test("follows strategy, type and phase", () => {
    expect(allowedTimesInForce(OrdType.Limit)).toEqual([
      TimeInForce.Day,
      TimeInForce.ImmediateOrCancel,
      TimeInForce.FillOrKill,
      TimeInForce.GoodTillCancel,
    ]);
    expect(allowedTimesInForce(OrdType.Market)).not.toContain(
      TimeInForce.GoodTillCancel,
    );
    expect(allowedTimesInForce(OrdType.Limit, AlgoStrategy.Twap)).toEqual([
      TimeInForce.Day,
      TimeInForce.GoodTillCancel,
    ]);
    expect(
      allowedTimesInForce(
        OrdType.Limit,
        AlgoStrategy.Dma,
        TradingPhase.PreOpen,
      ),
    ).toEqual([TimeInForce.Day, TimeInForce.GoodTillCancel]);
  });
});

describe("review and schedule", () => {
  test("a price outside the collar needs review", () => {
    const risk = previewRisk(draft({ price: "50" }), instrument, undefined);
    expect(reviewReasons(risk).map((w) => w.code)).toContain("collar");
    expect(
      reviewReasons(previewRisk(draft(), instrument, undefined)),
    ).toHaveLength(0);
  });

  test("one line per strategy", () => {
    expect(scheduleSummary(draft(), 1000)).toBeNull();
    expect(
      scheduleSummary(
        draft({
          strategy: AlgoStrategy.Twap,
          algoParams: { durationMins: "10" },
        }),
        1000,
      ),
    ).toBe("≈ 100 a minute for 10 min");
    expect(
      scheduleSummary(
        draft({ strategy: AlgoStrategy.Vwap, algoParams: { endTime: "1530" } }),
        1000,
      ),
    ).toBe("Follows the volume curve until 15:30");
    expect(
      scheduleSummary(
        draft({
          strategy: AlgoStrategy.Pov,
          algoParams: { participationPct: "10%" },
        }),
        1000,
      ),
    ).toBe("10% of market volume until the close");
  });
});

describe("order line", () => {
  test("side, quantity, instrument, price, strategy and parameters", () => {
    const { change, words } = parseOrderLine("b 20k aal.l m vwap 15:30");
    expect(change).toEqual({
      side: Side.Buy,
      quantity: "20k",
      ric: "AAL.L",
      price: "m",
      ordType: OrdType.Limit,
      strategy: AlgoStrategy.Vwap,
      algoParams: { endTime: "15:30" },
    });
    expect(words.every((w) => w.label)).toBe(true);
  });

  test("market, POV parameters, and unknown words", () => {
    const { change, words } = parseOrderLine("s 5k mkt pov 10% 1h zzz");
    expect(change).toMatchObject({
      side: Side.Sell,
      quantity: "5k",
      ordType: OrdType.Market,
      strategy: AlgoStrategy.Pov,
      algoParams: { participationPct: "10%", durationMins: "1h" },
    });
    expect(change.ric).toBeUndefined();
    expect(words.at(-1)).toEqual({ text: "zzz", label: undefined });
  });

  test("after the strategy, a bare number is its next parameter", () => {
    expect(parseOrderLine("b 2k pov 10").change).toMatchObject({
      strategy: AlgoStrategy.Pov,
      algoParams: { participationPct: "10" },
    });
    expect(parseOrderLine("b 2k pov 10").change.price).toBeUndefined();
    expect(parseOrderLine("s 1k twap 45").change.algoParams).toEqual({
      durationMins: "45",
    });
    // Out of range for the parameter: not taken as it (here, a price).
    expect(parseOrderLine("b 2k pov 99").change).toMatchObject({
      price: "99",
      algoParams: {},
    });
  });

  test("stop and stop limit", () => {
    const stop = parseOrderLine("s 200 vod.l stop 99.5");
    expect(stop.change).toEqual({
      side: Side.Sell,
      quantity: "200",
      ric: "VOD.L",
      stopPrice: "99.5",
      ordType: OrdType.Stop,
    });
    expect(stop.words.map((w) => w.label)).toEqual([
      "Sell",
      "Qty 200",
      "VOD.L",
      "Stop",
      "Stop 99.5",
    ]);
    expect(parseOrderLine("s 200 vod.l stop 99.5 lmt 99.4").change).toEqual({
      side: Side.Sell,
      quantity: "200",
      ric: "VOD.L",
      stopPrice: "99.5",
      price: "99.4",
      ordType: OrdType.StopLimit,
    });
    // lmt is optional; the limit can come first; stp works too.
    expect(parseOrderLine("b 1k vod.l 101 stp 100.5").change).toMatchObject({
      price: "101",
      stopPrice: "100.5",
      ordType: OrdType.StopLimit,
    });
    // The stop takes the next price even before a quantity.
    expect(parseOrderLine("b stop a+2 500").change).toMatchObject({
      stopPrice: "a+2",
      quantity: "500",
      ordType: OrdType.Stop,
    });
    // `stop` alone picks the type; the stop price is left to fill in.
    expect(parseOrderLine("s 200 stop").change).toMatchObject({
      ordType: OrdType.Stop,
    });
    expect(parseOrderLine("s 200 stop").change.stopPrice).toBeUndefined();
  });

  test("an order line has a space; a search does not", () => {
    expect(isOrderLine("vod")).toBe(false);
    expect(isOrderLine("b 5k")).toBe(true);
  });
});
