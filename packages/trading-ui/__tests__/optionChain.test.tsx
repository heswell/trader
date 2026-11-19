import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  InstrumentType,
  OrdType,
  PutCall,
  Side,
} from "@heswell/trading-schemas";
import {
  createTradingTestData,
  setCurrentUser,
} from "@heswell/trading-test-data";
import { createTradingLocalServer } from "@heswell/trading-test-data/react";
import { cleanup, render, waitFor } from "@testing-library/react";
import {
  buildOptionChain,
  EMPTY_DRAFT,
  nearestLiquid,
  OptionChain,
  otherRight,
  parseOptionSpec,
  parseOrderLine,
  previewRisk,
  resolveOptionSpec,
  stepExpiry,
  stepStrike,
  TradingDataProvider,
  underlyingFilter,
} from "../src";

const NOV = Date.UTC(2026, 10, 20, 16, 30);
const DEC = Date.UTC(2026, 11, 18, 16, 30);
const NOW = Date.UTC(2026, 10, 12, 14, 0);

/** instrumentPrices rows of a small chain: 170-180 on two expiries. */
const optionRows = () => {
  const rows: Record<string, unknown>[] = [];
  for (const expiry of [NOV, DEC]) {
    for (const strike of [170, 175, 180]) {
      for (const putCall of [PutCall.Call, PutCall.Put]) {
        rows.push({
          ric: `AAPL${strike}${putCall === PutCall.Call ? "C" : "P"}${expiry === NOV ? "N" : "D"}`,
          underlying: "AAPL.OQ",
          putCall,
          strike,
          expiry,
          liquid: expiry === NOV && strike !== 180,
          bid: 4.1,
          ask: 4.3,
          tickSize: 0.01,
          contractMultiplier: 100,
        });
      }
    }
  }
  return rows as never[];
};
const analyticsRows = [
  { ric: "AAPL175CN", forward: 176, impliedVol: 0.95, delta: 0.52 },
  { ric: "AAPL175CD", forward: 177, impliedVol: 0.93, delta: 0.55 },
] as never[];

describe("option chain model", () => {
  const chain = buildOptionChain(optionRows(), analyticsRows, NOW);

  test("groups options by expiry and strike, with analytics", () => {
    expect(chain.underlyings).toEqual(["AAPL.OQ"]);
    expect(chain.expiries).toEqual([NOV, DEC]);
    expect(chain.strikes.get(NOV)?.map((s) => s.strike)).toEqual([
      170, 175, 180,
    ]);
    const atm = chain.strikes.get(NOV)?.[1];
    expect(atm?.call).toMatchObject({
      ric: "AAPL175CN",
      liquid: true,
      impliedVol: 0.95,
      delta: 0.52,
      bid: 4.1,
    });
    expect(atm?.put?.putCall).toBe(PutCall.Put);
    expect(chain.forwards.get(DEC)).toBe(177);
    // expired options are left out
    expect(buildOptionChain(optionRows(), [], NOV + 1).expiries).toEqual([DEC]);
  });

  test("steps strikes, expiries and the right; finds a liquid strike", () => {
    expect(stepStrike(chain, "AAPL175CN", 1)?.ric).toBe("AAPL180CN");
    expect(stepStrike(chain, "AAPL175CN", -5)?.ric).toBe("AAPL170CN");
    expect(stepExpiry(chain, "AAPL175PN", 1)?.ric).toBe("AAPL175PD");
    expect(otherRight(chain, "AAPL170CD")?.ric).toBe("AAPL170PD");
    expect(nearestLiquid(chain, "AAPL180CN")?.ric).toBe("AAPL175CN");
    // no liquid strike in December
    expect(nearestLiquid(chain, "AAPL180CD")).toBeUndefined();
  });

  test("parses and resolves typed options", () => {
    expect(parseOptionSpec("AAPL 175c")).toEqual({
      underlying: "AAPL",
      strike: 175,
      putCall: PutCall.Call,
    });
    expect(parseOptionSpec("aapl.oq 102.5p dec27")).toEqual({
      underlying: "AAPL.OQ",
      strike: 102.5,
      putCall: PutCall.Put,
      month: 11,
      year: 2027,
    });
    expect(parseOptionSpec("aapl 175")).toBeUndefined();
    expect(parseOptionSpec("aapl 175c xyz")).toBeUndefined();
    const front = parseOptionSpec("AAPL 175c");
    const dec = parseOptionSpec("AAPL 175p december");
    if (!front || !dec) throw Error("unparsed");
    expect(resolveOptionSpec(chain, front)?.ric).toBe("AAPL175CN");
    expect(resolveOptionSpec(chain, dec)?.ric).toBe("AAPL175PD");
    expect(resolveOptionSpec(chain, { ...front, strike: 999 })).toBeUndefined();
  });

  test("filters a ric or its root", () => {
    expect(underlyingFilter("aapl")).toBe(
      '(underlying = "AAPL" or underlying starts "AAPL.")',
    );
    expect(underlyingFilter(" ")).toBeUndefined();
  });
});

describe("option order lines", () => {
  test("a whole option order", () => {
    const line = parseOrderLine("b 10 aapl 200c jan @ 3.5");
    expect(line.option).toEqual({
      underlying: "AAPL",
      strike: 200,
      putCall: PutCall.Call,
      month: 0,
    });
    expect(line.change).toMatchObject({
      side: Side.Buy,
      quantity: "10",
      price: "3.5",
      ordType: OrdType.Limit,
    });
    expect(line.change.ric).toBeUndefined();
    expect(line.words.map((w) => w.label)).toEqual([
      "Buy",
      "Qty 10",
      "AAPL",
      "200 Call",
      "Jan",
      undefined,
      "@ 3.5",
    ]);
  });

  test("a ric underlying, and the ticket's own underlying", () => {
    expect(parseOrderLine("aapl.oq 175p").option?.underlying).toBe("AAPL.OQ");
    const own = parseOrderLine("s 5 175p");
    expect(own.option).toMatchObject({ underlying: "", putCall: PutCall.Put });
    expect(own.change).toMatchObject({ side: Side.Sell, quantity: "5" });
  });

  test("lines without a strike word are not options", () => {
    expect(parseOrderLine("b 100 aapl.oq 175").option).toBeUndefined();
  });
});

describe("option risk preview", () => {
  test("the collar is wider for an option", () => {
    const option = {
      ric: "AAPL175K6",
      instrumentType: InstrumentType.Option,
      currency: "USD",
      tickSize: 0.01,
      contractMultiplier: 100,
      bid: 9.9,
      ask: 10.1,
    };
    const at = (price: string) =>
      previewRisk(
        { ...EMPTY_DRAFT, ric: option.ric, quantity: "1", price },
        option,
        undefined,
      ).warnings.map((w) => w.code);
    expect(at("7")).not.toContain("collar"); // 30% away
    expect(at("4")).toContain("collar"); // 60% away
    // premium notional: 1 contract x 7 x 100
    expect(
      previewRisk(
        { ...EMPTY_DRAFT, ric: option.ric, quantity: "1", price: "7" },
        option,
        undefined,
      ).notional,
    ).toBe(700);
  });
});

describe("OptionChain", () => {
  setCurrentUser({ name: "admin", authorizations: [] });
  const testData = createTradingTestData({
    seed: 5,
    exchange: { activeInstruments: 3, options: "AAPL.OQ" },
    oms: { flowRate: 0 },
    manualClock: true,
  });
  const localServer = createTradingLocalServer(testData, "option-chain");
  afterEach(cleanup);
  afterAll(() => testData.dispose());

  test("lists the front expiry's strikes, liquid ones marked", async () => {
    const { container } = render(
      <TradingDataProvider localServer={localServer} mode="local">
        <OptionChain underlying="AAPL.OQ" />
      </TradingDataProvider>,
    );
    await waitFor(
      () =>
        expect(
          container.querySelectorAll(".tradingOptionChain-row").length,
        ).toBe(21),
      { timeout: 3000 },
    );
    expect(
      container.querySelectorAll(".tradingOptionChain-row[data-liquid]").length,
    ).toBe(5);
    expect(container.querySelectorAll('[role="tab"]').length).toBe(2);
    expect(
      container.querySelector('[role="tab"][aria-selected="true"]'),
    ).not.toBeNull();
  });
});
