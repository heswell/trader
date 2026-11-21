import { describe, expect, test } from "bun:test";
import {
  EntryRiskCode,
  InstrumentType,
  OrdStatus,
  RejectReason,
  Side,
} from "@heswell/trading-schemas";
import { SEED_ACCOUNTS } from "../src/reference/accounts";
import { riskLimitBreaches } from "../src/risk/preTradeRisk";
import { AAPL, BookSide, setup } from "./fixture";

// Thu 12 Nov 2026; the front expiry is Fri 20 Nov. AAPL lists 165–185
// strikes with books (±2 around 175); 200 is quote-only.
const NOW = Date.UTC(2026, 10, 12, 14, 0);
const CALL = "AAPL175K6";
const PUT = "AAPL175W6";
const WING = "AAPL200K6";

const onTick = (n: number) => Math.round(n * 100) / 100;

const optionsSetup = (maxDeltaUsd?: number) => {
  const accounts =
    maxDeltaUsd === undefined
      ? SEED_ACCOUNTS
      : SEED_ACCOUNTS.map((a) =>
          a.account === "ACC-US-01" ? { ...a, maxDeltaUsd } : a,
        );
  const t = setup({
    time: NOW,
    accounts,
    simConfig: { options: "AAPL.OQ", optionsExpiries: 1 },
  });
  const def = (ric: string) => {
    const instrument = t.sim.gateway.getInstrument(ric);
    if (!instrument) throw Error(`no ${ric}`);
    return instrument;
  };
  /** Fill `quantity` of `ric` for ACC-US-01 against a resting bot order. */
  const trade = (ric: string, side: Side, quantity: number) => {
    const { refPrice } = def(ric);
    t.rest(
      ric,
      side === Side.Buy ? BookSide.SELL : BookSide.BUY,
      refPrice,
      quantity,
    );
    return t.create({ ric, side, quantity, price: refPrice });
  };
  return { ...t, def, trade };
};

describe("options in the OMS: Greeks and risk", () => {
  test("positions carry delta, gamma and vega; a stock is delta one", () => {
    const { sim, engine, trade, status } = optionsSetup();
    expect(status(trade(CALL, Side.Buy, 3))?.status).toBe(OrdStatus.Filled);
    expect(status(trade(AAPL, Side.Buy, 200))?.status).toBe(OrdStatus.Filled);

    const greeks = sim.gateway.getOptionGreeks(CALL);
    if (!greeks) throw Error("no Greeks");
    const call = engine.getPosition("ACC-US-01", CALL);
    expect(call).toMatchObject({
      instrumentType: InstrumentType.Option,
      underlying: AAPL,
    });
    expect(call?.delta).toBeCloseTo(300 * greeks.delta, 2);
    expect(call?.deltaUsd).toBeCloseTo(300 * greeks.delta * greeks.forward, 0);
    expect(call?.gamma).toBeCloseTo(300 * greeks.gamma, 3);
    expect(call?.vegaUsd).toBeCloseTo(3 * greeks.vega, 1);
    expect(call?.gamma).toBeGreaterThan(0);

    const stock = engine.getPosition("ACC-US-01", AAPL);
    expect(stock).toMatchObject({ delta: 200, gamma: 0, vegaUsd: 0 });
    expect(stock?.deltaUsd).toBe(stock?.marketValueUsd ?? -1);
    expect(engine.underlyingDeltaUsd("ACC-US-01", AAPL)).toBeCloseTo(
      (call?.deltaUsd ?? 0) + (stock?.deltaUsd ?? 0),
      6,
    );
  });

  test("Greeks follow the underlying on mark to market", () => {
    const { sim, engine, trade } = optionsSetup();
    trade(CALL, Side.Buy, 2);
    const before = engine.getPosition("ACC-US-01", CALL)?.delta ?? 0;
    sim.getBook(AAPL)?.model.shift(500); // ~5% up: the call's delta rises
    engine.markToMarket();
    expect(engine.getPosition("ACC-US-01", CALL)?.delta).toBeGreaterThan(
      before,
    );
  });

  test("the collar is wider for options", () => {
    const { engine, order, ctx, def } = optionsSetup();
    const { refPrice } = def(CALL);
    // 30% under the reference: outside the 10% equity collar, inside 50%
    const inside = engine.createOrder(
      order({ ric: CALL, quantity: 1, price: onTick(refPrice * 0.7) }),
      ctx,
    );
    expect(inside.ok).toBe(true);
    const outside = engine.createOrder(
      order({ ric: CALL, quantity: 1, price: onTick(refPrice * 0.4) }),
      ctx,
    );
    expect(outside.ok).toBe(false);
    if (!outside.ok) {
      expect(outside.reason).toBe(RejectReason.PriceOutsideCollar);
    }
  });

  test("a quote-only strike is refused with the nearest liquid one", () => {
    const { engine, order, ctx, def } = optionsSetup();
    const result = engine.createOrder(
      order({ ric: WING, quantity: 1, price: def(WING).refPrice }),
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe(RejectReason.RestrictedInstrument);
      expect(result.text).toContain("AAPL185K6");
    }
  });

  test("the delta limit nets a stock with its options", () => {
    const { engine, order, ctx, def, trade, sim } = optionsSetup(100_000);
    trade(AAPL, Side.Buy, 400); // ~70k USD of delta
    const call = def(CALL);
    const greeks = sim.gateway.getOptionGreeks(CALL);
    expect(greeks?.delta).toBeGreaterThan(0.3);
    // 4 calls add ~37k: over 100k
    const more = engine.createOrder(
      order({ ric: CALL, quantity: 4, price: call.refPrice }),
      ctx,
    );
    expect(more.ok).toBe(false);
    if (!more.ok) {
      expect(more.reason).toBe(RejectReason.ExceedsMaxDelta);
      expect(more.text).toMatch(/net delta on AAPL\.OQ/);
    }
    // puts reduce it: allowed
    const hedge = engine.createOrder(
      order({ ric: PUT, quantity: 3, price: def(PUT).refPrice }),
      ctx,
    );
    expect(hedge.ok).toBe(true);
  });

  test("riskLimitBreaches lists the delta breach for the ticket", () => {
    const { engine } = optionsSetup(50_000);
    const account = engine.accounts.get("ACC-US-01");
    const ctx = engine.riskContext("ACC-US-01", CALL);
    if (!account || !ctx.instrument) throw Error("setup");
    const breaches = riskLimitBreaches(
      {
        account: "ACC-US-01",
        ric: CALL,
        side: Side.Buy,
        ordType: "LIMIT",
        quantity: 10,
        price: ctx.instrument.refPrice,
      },
      account,
      ctx.instrument,
      ctx,
    );
    expect(breaches.map((b) => b.code)).toContain(EntryRiskCode.MaxDelta);
  });
});
