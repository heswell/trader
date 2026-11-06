import { describe, expect, test } from "bun:test";
import { Side as BookSide } from "@heswell/hft-limit-order-book";
import { isOnTick } from "@heswell/trading-schemas";
import { MarketMaker } from "../src/engine/bots/MarketMaker";
import { NoiseTaker } from "../src/engine/bots/NoiseTaker";
import { isBotOwner } from "../src/engine/bots/OrderPort";
import {
  createExchangeSimulator,
  type SimulatedInstrument,
} from "../src/engine/ExchangeSimulator";
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

const makers = (s: SimulatedInstrument | undefined) =>
  (s?.bots ?? []).filter(
    (bot): bot is MarketMaker => bot instanceof MarketMaker,
  );
const takers = (s: SimulatedInstrument | undefined) =>
  (s?.bots ?? []).filter((bot): bot is NoiseTaker => bot instanceof NoiseTaker);
const takerOrders = (s: SimulatedInstrument | undefined) =>
  takers(s).reduce((n, bot) => n + bot.port.ledger.orders, 0);

describe("MarketMaker", () => {
  test("quotes N levels each side, on tick, identifiable by account/owner", () => {
    const { sim, run } = setup({ takerRate: 0, mmLevels: 4 });
    run(100);
    for (const ric of ["VOD.L", "AAPL.OQ", "0005.HK"]) {
      const s = sim.getSimulated(ric);
      if (!s) throw Error(ric);
      for (const mm of makers(s)) {
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
          expect(order?.accountId).toBe(mm.account);
          expect(order?.owner).toBe(`bot:${ric}/${mm.localId}`);
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
    for (const mm of makers(s)) {
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
    const [mm] = makers(s);
    expect(mm.params.halfSpreadTicks).toBeGreaterThan(1);
    const centre = s.book.model.fairOnTick;
    const neutral = mm.targetPrices(BookSide.BUY, centre)[0];
    mm.port.ledger.position = mm.params.baseQty * 100;
    expect(mm.skewTicks()).toBeLessThan(0);
    mm.port.ledger.position = -mm.params.baseQty * 100;
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
    const s = sim.getSimulated("VOD.L");
    // ~20/s for 20s across the takers; Poisson, and market orders are
    // skipped while a side is empty, so allow slack
    expect(takerOrders(s)).toBeGreaterThan(300);
    expect(takerOrders(s)).toBeLessThan(500);
    for (const taker of takers(s)) {
      expect(taker.port.ledger.orders).toBeGreaterThan(60);
    }
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
    const taker = seen.filter(
      ({ owner }) =>
        typeof owner === "string" && owner.startsWith("bot:AAPL.OQ/TAKER"),
    );
    expect(taker.length).toBeGreaterThan(200);
    for (const order of taker) {
      // one account per taker, matching its owner
      expect(order.owner).toBe(`bot:AAPL.OQ/${order.accountId}`);
    }
    expect(new Set(taker.map(({ accountId }) => accountId))).toEqual(
      new Set(["TAKER1", "TAKER2", "TAKER3"]),
    );
    const kinds = new Set(taker.map(({ kind }) => kind));
    expect(kinds).toEqual(new Set(["MARKET", "IOC", "GTC"]));
    expect(seen.every(({ owner }) => isBotOwner(owner))).toBe(true);
    expect(seen.some(({ owner }) => owner === "bot:AAPL.OQ/MM1")).toBe(true);
  });

  test("setBotRate changes the rate per bot type", () => {
    const { sim, run } = setup();
    sim.setBotRate(undefined, "TAKER", 0);
    const s = sim.getSimulated("VOD.L");
    const sent = takerOrders(s);
    run(2_000);
    expect(takerOrders(s)).toBe(sent);
    sim.setBotRate("VOD.L", "TAKER", 100);
    run(1_000);
    expect(takerOrders(s)).toBeGreaterThan(sent + 50);
  });
});
