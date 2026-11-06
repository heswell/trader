import { describe, expect, test } from "bun:test";
import { Side as BookSide, type Trade } from "@heswell/hft-limit-order-book";
import { BotKind } from "../src/engine/bots/Bot";
import { BotLedger } from "../src/engine/bots/BotLedger";
import type { MarketMaker } from "../src/engine/bots/MarketMaker";
import { MarketSignals } from "../src/engine/bots/MarketSignals";
import { OrderPort } from "../src/engine/bots/OrderPort";
import { createBots, defaultRoster } from "../src/engine/bots/roster";
import { DEFAULT_CONFIG } from "../src/config";
import { createExchangeSimulator } from "../src/engine/ExchangeSimulator";
import type { ExchangeState } from "../src/engine/persistence";
import { ManualClock } from "../src/util/clock";
import { Random } from "../src/util/random";

/** A trade where the aggressor is on `side`. */
const trade = (side: BookSide, price: number, size: number) =>
  ({ side, price, size }) as Trade;

const setup = (config = {}) => {
  const clock = new ManualClock();
  const sim = createExchangeSimulator({
    clock: clock.now,
    config: { instruments: "VOD.L,AAPL.OQ", ...config },
  });
  const run = (ms: number) => {
    for (let t = 0; t < ms; t += 20) sim.step(clock.advance(20));
  };
  return { clock, sim, run };
};

describe("BotLedger", () => {
  test("tracks position, average cost and realised P&L through a flip", () => {
    const ledger = new BotLedger();
    // taker buy 100 @ 10, then taker buy 100 @ 12: long 200 @ 11
    ledger.recordFill(trade(BookSide.BUY, 10, 100), false);
    ledger.recordFill(trade(BookSide.BUY, 12, 100), false);
    expect(ledger.position).toBe(200);
    expect(ledger.avgPrice).toBeCloseTo(11);
    // maker fill against an aggressive buyer = we sell 300 @ 13
    ledger.recordFill(trade(BookSide.BUY, 13, 300), true);
    expect(ledger.position).toBe(-100);
    expect(ledger.realisedPnl).toBeCloseTo(400); // 200 * (13 - 11)
    expect(ledger.avgPrice).toBe(13); // the flipped remainder opens at 13
    expect(ledger.unrealisedPnl(12)).toBeCloseTo(100); // short 100 from 13
    expect(ledger.totalPnl(12)).toBeCloseTo(500);
    expect(ledger.cash).toBeCloseTo(-1000 - 1200 + 3900);
    expect(ledger.fills).toBe(3);
    expect(ledger.makerFills).toBe(1);
    expect(ledger.takerFills).toBe(2);
    expect(ledger.volume).toBe(500);
    // P&L identity: cash + position * mark
    expect(ledger.cash + ledger.position * 12).toBeCloseTo(ledger.totalPnl(12));
  });

  test("closing flat resets the average price", () => {
    const ledger = new BotLedger();
    ledger.recordFill(trade(BookSide.SELL, 20, 50), false);
    ledger.recordFill(trade(BookSide.SELL, 18, 50), true);
    expect(ledger.position).toBe(0);
    expect(ledger.avgPrice).toBe(0);
    expect(ledger.realisedPnl).toBeCloseTo(100);
  });

  test("restores only finite numbers", () => {
    const ledger = new BotLedger();
    ledger.restoreState({ position: 7, cash: Number.NaN, orders: 3 });
    expect(ledger.position).toBe(7);
    expect(ledger.cash).toBe(0);
    expect(ledger.orders).toBe(3);
  });
});

describe("OrderPort", () => {
  test("stamps account and owner, counts orders and tracks resting ones", () => {
    const { sim } = setup({ mmRate: 0, takerRate: 0 });
    const book = sim.getBook("VOD.L");
    if (!book) throw Error();
    const seller = new OrderPort(book, "VOD.L/S", "S1", "TS");
    const buyer = new OrderPort(book, "VOD.L/B", "B1", "TB");
    const price = book.model.fairOnTick;
    const resting = seller.limit({ side: BookSide.SELL, size: 300, price });
    expect(seller.isResting(resting)).toBe(true);
    expect(book.book.order(resting)?.accountId).toBe("S1");
    expect(book.book.order(resting)?.owner).toBe("bot:VOD.L/S");
    expect(seller.restingQty()).toEqual({ bid: 0, ask: 300 });

    buyer.market({ side: BookSide.BUY, size: 100 });
    expect(seller.ledger.position).toBe(-100);
    expect(seller.ledger.makerFills).toBe(1);
    expect(buyer.ledger.position).toBe(100);
    expect(buyer.ledger.makerFills).toBe(0);
    expect(seller.isResting(resting)).toBe(true);

    buyer.market({ side: BookSide.BUY, size: 200 });
    expect(seller.isResting(resting)).toBe(false);
    expect(seller.restingCount).toBe(0);

    const id = seller.limit({ side: BookSide.SELL, size: 100, price });
    expect(seller.modify(id, { size: 50 })).toBe(true);
    seller.pullAll();
    expect(book.book.order(id)).toBeUndefined();
    expect(seller.ledger.orders).toBe(2);
    expect(seller.ledger.modifies).toBe(1);
    expect(seller.ledger.cancels).toBe(1);
  });

  test("simulated bots' ledgers agree with the trades they did", () => {
    const { sim, run } = setup({ defaultVolatility: 0.5 });
    run(10_000);
    for (const ric of ["VOD.L", "AAPL.OQ"]) {
      const bots = sim.getBots(ric);
      const bought = bots.reduce((n, b) => n + b.port.ledger.boughtQty, 0);
      const sold = bots.reduce((n, b) => n + b.port.ledger.soldQty, 0);
      // bots only trade with each other here, so every trade is booked twice
      expect(bought).toBe(sold);
      expect(bought).toBe(sim.getBook(ric)?.stats.volume ?? -1);
      const position = bots.reduce((n, b) => n + b.port.ledger.position, 0);
      expect(position).toBe(0);
      for (const bot of bots) {
        const quotes =
          bot.kind === BotKind.MarketMaker
            ? (bot as MarketMaker).quoteCount
            : undefined;
        if (quotes !== undefined) expect(bot.port.restingCount).toBe(quotes);
      }
    }
  });
});

describe("rosters", () => {
  test("default roster: market makers quote first, one account per taker", () => {
    const { sim } = setup();
    const ids = sim.getBots("VOD.L").map((bot) => bot.id);
    expect(ids).toEqual([
      "VOD.L/MM1",
      "VOD.L/MM2",
      "VOD.L/TAKER1",
      "VOD.L/TAKER2",
      "VOD.L/TAKER3",
    ]);
    expect(sim.getBots("VOD.L").map((bot) => bot.account)).toEqual([
      "MM1",
      "MM2",
      "TAKER1",
      "TAKER2",
      "TAKER3",
    ]);
  });

  test("adding a bot leaves the other bots' random streams unchanged", () => {
    const { sim } = setup({ mmRate: 0, takerRate: 0 });
    const book = sim.getBook("VOD.L");
    if (!book) throw Error();
    const roster = defaultRoster({ ...DEFAULT_CONFIG, mmPerInstrument: 2 });
    const bigger = defaultRoster({ ...DEFAULT_CONFIG, mmPerInstrument: 3 });
    const a = createBots(roster, book, new Random(9), 100);
    const b = createBots(bigger, book, new Random(9), 100);
    const params = (bots: typeof a, id: string) =>
      bots.find((bot) => bot.localId === id)?.params;
    expect(params(b, "MM1")).toEqual(params(a, "MM1") ?? {});
    expect(params(b, "MM2")).toEqual(params(a, "MM2") ?? {});
    expect(b.map((bot) => bot.localId)).toContain("MM3");
  });
});

describe("MarketSignals", () => {
  test("EMAs, returns, volatility and trade imbalance", () => {
    const signals = new MarketSignals();
    signals.update(0.02, 0, 0);
    expect(signals.mid).toBeNaN();
    signals.update(0.02, 99, 101);
    expect(signals.mid).toBe(100);
    expect(signals.midEma).toEqual([100, 100, 100]);
    for (let i = 0; i < 500; i++) signals.update(0.02, 109, 111);
    // 10s at mid 110: the 1s EMA has caught up, the 60s one has not
    expect(signals.midEma[0]).toBeCloseTo(110, 3);
    expect(signals.midEma[2]).toBeLessThan(103);
    expect(signals.returnBps(2)).toBeGreaterThan(0);
    expect(signals.volBpsPerSqrtSec).toBeGreaterThan(0);

    signals.onTrade(trade(BookSide.BUY, 110, 300));
    signals.onTrade(trade(BookSide.SELL, 110, 100));
    signals.update(0.02, 109, 111);
    expect(signals.imbalance).toBeCloseTo(0.5);
    expect(signals.lastTradePrice).toBe(110);
  });

  test("the simulator keeps each instrument's signals current", () => {
    const { sim, run } = setup({ defaultVolatility: 0.5 });
    run(5_000);
    const s = sim.getSimulated("AAPL.OQ");
    const top = s?.book.topOfBook() ?? { bid: 0, ask: 0 };
    // taken at the start of the last step, before its bots acted
    const mid = (top.bid + top.ask) / 2;
    expect(Math.abs((s?.signals.mid ?? 0) - mid)).toBeLessThan(
      top.ask - top.bid,
    );
    expect(s?.signals.volBpsPerSqrtSec).toBeGreaterThan(0);
    expect(Math.abs(s?.signals.imbalance ?? 2)).toBeLessThanOrEqual(1);
  });
});

describe("ledger persistence", () => {
  test("bot ledgers survive a snapshot restore", () => {
    const a = setup({ defaultVolatility: 0.5 });
    a.run(5_000);
    const state = structuredClone(a.sim.exportState()) as ExchangeState;
    const before = a.sim.getBots().map((bot) => bot.port.ledger.exportState());
    expect(before.some((ledger) => ledger.fills > 0)).toBe(true);

    const b = setup({ defaultVolatility: 0.5 });
    b.sim.restoreState(state);
    expect(b.sim.getBots().map((bot) => bot.port.ledger.exportState())).toEqual(
      before,
    );
  });

  test("snapshots without ledgers still restore", () => {
    const a = setup({ mmRate: 0, takerRate: 0 });
    const state = structuredClone(a.sim.exportState()) as ExchangeState;
    for (const book of state.books) delete book.bots;
    const b = setup({ mmRate: 0, takerRate: 0 });
    b.sim.restoreState(state);
    expect(b.sim.getBots().every((bot) => bot.port.ledger.fills === 0)).toBe(
      true,
    );
  });
});
