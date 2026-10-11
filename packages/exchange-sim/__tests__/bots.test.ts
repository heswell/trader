import { describe, expect, test } from "bun:test";
import { Side as BookSide } from "@heswell/hft-limit-order-book";
import { isOnTick } from "@heswell/trading-schemas";
import { MM_OWNER } from "../src/engine/bots/MarketMaker";
import { TAKER_OWNER } from "../src/engine/bots/NoiseTaker";
import { createExchangeSimulator } from "../src/engine/ExchangeSimulator";
import { ManualClock } from "../src/util/clock";

const setup = (config = {}) => {
  const clock = new ManualClock();
  const sim = createExchangeSimulator({
    clock: clock.now,
    config: { instruments: "VOD.L,AAPL.OQ,0005.HK", ...config },
  });
  const run = (ms: number) => {
    for (let t = 0; t < ms; t += 20) sim.step(clock.advance(20));
  };
  return { clock, sim, run };
};

describe("MarketMaker", () => {
  test("quotes N levels each side, on tick, identifiable by account/owner", () => {
    const { sim, run } = setup({ takerRate: 0, mmLevels: 4 });
    run(100);
    for (const ric of ["VOD.L", "AAPL.OQ", "0005.HK"]) {
      const s = sim.getSimulated(ric);
      if (!s) throw Error(ric);
      for (const mm of s.marketMakers) {
        const quotes = mm.quotes();
        const bids = quotes.filter(({ side }) => side === BookSide.BUY);
        const asks = quotes.filter(({ side }) => side === BookSide.SELL);
        expect(bids).toHaveLength(4);
        expect(asks).toHaveLength(4);
        const maxBid = Math.max(...bids.map(({ price }) => price));
        const minAsk = Math.min(...asks.map(({ price }) => price));
        expect(maxBid).toBeLessThan(minAsk);
        for (const quote of quotes) {
          expect(isOnTick(quote.price, s.book.schedule)).toBe(true);
          expect(quote.size % s.book.instrument.lotSize).toBe(0);
          const order = s.book.book.order(quote.id);
          expect(order?.accountId).toBe(mm.params.account);
          expect(order?.owner).toBe(MM_OWNER);
        }
      }
    }
  });

  test("requotes with modify/cancel churn as fair value moves", () => {
    const { sim, run } = setup({ takerRate: 0, mmRate: 0.0001 });
    run(100);
    const book = sim.getBook("AAPL.OQ");
    if (!book) throw Error();
    const before = book.events;
    const tob = book.topOfBook();
    sim.setVolatility("AAPL.OQ", 2);
    run(5_000);
    expect(book.events - before).toBeGreaterThan(20);
    expect(book.topOfBook()).not.toEqual(tob);
    // every quote still rests in the book, nothing leaked
    const s = sim.getSimulated("AAPL.OQ");
    let resting = 0;
    for (const mm of s?.marketMakers ?? []) {
      for (const quote of mm.quotes()) {
        expect(book.book.order(quote.id)?.price).toBe(quote.price);
        resting++;
      }
    }
    const [asks, bids] = book.book.depthDetailed(1000);
    const bookCount = [...asks, ...bids].reduce((n, l) => n + l.count, 0);
    expect(bookCount).toBe(resting);
  });

  test("skews quotes against inventory", () => {
    const { sim, run } = setup({ takerRate: 0, defaultVolatility: 0.0001 });
    run(40);
    const s = sim.getSimulated("AAPL.OQ");
    if (!s) throw Error();
    const [mm] = s.marketMakers;
    expect(mm.params.halfSpreadTicks).toBeGreaterThan(1);
    const centre = s.book.model.fairOnTick;
    const neutral = mm.targetPrices(BookSide.BUY, centre)[0];
    mm.position = mm.params.baseQty * 100;
    expect(mm.skewTicks()).toBeLessThan(0);
    mm.position = -mm.params.baseQty * 100;
    expect(mm.skewTicks()).toBeGreaterThan(0);
    expect(Math.abs(mm.skewTicks())).toBeLessThan(mm.params.halfSpreadTicks);
    expect(neutral).toBeLessThan(centre);
  });

  test("rate 0 pauses market makers", () => {
    const { sim, run } = setup({ takerRate: 0, mmRate: 0 });
    run(1_000);
    expect(sim.bookEvents).toBe(0);
  });
});

describe("NoiseTaker", () => {
  test("generates trades at roughly the configured rate", () => {
    const { sim, run } = setup({ takerRate: 20 });
    run(20_000);
    const taker = sim.getSimulated("VOD.L")?.taker;
    // ~20/s for 20s; Poisson so allow slack
    expect(taker?.ordersSent).toBeGreaterThan(300);
    expect(taker?.ordersSent).toBeLessThan(500);
    expect(sim.getBook("VOD.L")?.stats.tradeCount).toBeGreaterThan(50);
  });

  test("taker orders are identifiable and use the full order mix", () => {
    const { sim, run } = setup({ takerRate: 50 });
    const book = sim.getBook("AAPL.OQ");
    if (!book) throw Error();
    const seen: { owner?: unknown; accountId?: string; kind: string }[] = [];
    const limit = book.limit.bind(book);
    const market = book.market.bind(book);
    book.limit = (options, sink) => {
      seen.push({ ...options, kind: options.timeInForce ?? "GTC" });
      return limit(options, sink);
    };
    book.market = (options, sink) => {
      seen.push({ ...options, kind: "MARKET" });
      return market(options, sink);
    };
    run(10_000);
    const taker = seen.filter(({ owner }) => owner === TAKER_OWNER);
    expect(taker.length).toBeGreaterThan(200);
    for (const order of taker) {
      expect(["TAKER1", "TAKER2", "TAKER3"]).toContain(order.accountId ?? "");
    }
    const kinds = new Set(taker.map(({ kind }) => kind));
    expect(kinds).toEqual(new Set(["MARKET", "IOC", "GTC"]));
    expect(seen.some(({ owner }) => owner === MM_OWNER)).toBe(true);
  });

  test("setBotRate changes the rate per bot type", () => {
    const { sim, run } = setup();
    sim.setBotRate(undefined, "TAKER", 0);
    const taker = sim.getSimulated("VOD.L")?.taker;
    const sent = taker?.ordersSent;
    run(2_000);
    expect(taker?.ordersSent).toBe(sent);
    sim.setBotRate("VOD.L", "TAKER", 100);
    run(1_000);
    expect(taker?.ordersSent).toBeGreaterThan((sent ?? 0) + 50);
  });
});
