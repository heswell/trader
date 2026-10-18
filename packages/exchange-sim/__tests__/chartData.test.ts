import { describe, expect, test } from "bun:test";
import { Side as BookSide } from "@heswell/hft-limit-order-book";
import {
  barKey,
  bookSampleKey,
  parseBarInterval,
  roundToTick,
} from "@heswell/trading-schemas";
import { loadExchangeSimConfig } from "../src/config";
import { generateBackfillBars } from "../src/engine/barBackfill";
import { createExchangeSimulator } from "../src/engine/ExchangeSimulator";
import { BarAggregator } from "../src/publish/BarAggregator";
import { ManualClock } from "../src/util/clock";
import { Random } from "../src/util/random";
import { createFakeTables, FakeTable } from "./fakeTables";
import { createExchangeTableDefs } from "@heswell/trading-schemas/server";

const T0 = 1_700_000_040_000; // a whole minute
const defs = createExchangeTableDefs();

const aggregator = (intervals = ["1s", "1m"], history = 3) => {
  const table = new FakeTable(defs.bars.columns, defs.bars.keyField);
  const stats = { barInserts: 0, barUpdates: 0, barEvictions: 0 };
  const bars = new BarAggregator(
    table,
    { intervals, history, decimals: () => 2 },
    stats,
  );
  return { table, stats, bars };
};

/** One instrument, bots paused: the test drives the book directly. */
const quietSim = (config = {}) => {
  const clock = new ManualClock(T0);
  const sim = createExchangeSimulator({
    clock: clock.now,
    config: {
      instruments: "AAPL.OQ",
      mmRate: 0,
      takerRate: 0,
      barBackfill: 0,
      ...config,
    },
  });
  const tables = createFakeTables();
  sim.attachTables(tables);
  const book = sim.getBook("AAPL.OQ");
  if (!book) throw Error("no book");
  let n = 0;
  const limit = (side: BookSide, price: number, size: number) =>
    book.limit({ id: `t${++n}`, side, price, size });
  /** A trade of `size` at `price` (resting sell, crossing buy). */
  const trade = (price: number, size: number) => {
    limit(BookSide.SELL, price, size);
    limit(BookSide.BUY, price, size);
  };
  return { clock, sim, tables, book, limit, trade };
};

describe("BarAggregator", () => {
  test("OHLCV, turnover and vwap; the current bar updates in place", () => {
    const { table, bars, stats } = aggregator(["1m"]);
    bars.addTrade("X", 10, 100, T0 + 1_000);
    bars.addTrade("X", 12, 50, T0 + 2_000);
    bars.addTrade("X", 9, 25, T0 + 3_000);
    bars.flush(T0 + 3_000);
    const key = barKey("X", "1m", T0);
    expect(table.get(key)).toMatchObject({
      ric: "X",
      interval: "1m",
      start: T0,
      end: T0 + 60_000,
      open: 10,
      high: 12,
      low: 9,
      close: 9,
      volume: 175,
      turnover: 10 * 100 + 12 * 50 + 9 * 25,
      vwap: Math.round(((10 * 100 + 12 * 50 + 9 * 25) / 175) * 1e4) / 1e4,
      trades: 3,
      closed: false,
      backfilled: false,
    });
    expect(stats.barInserts).toBe(1);
    bars.addTrade("X", 11, 10, T0 + 4_000);
    bars.addTrade("X", 11.5, 10, T0 + 5_000);
    bars.flush(T0 + 5_000);
    // coalesced: two trades, one update
    expect(stats).toMatchObject({ barInserts: 1, barUpdates: 1 });
    expect(table.get(key)).toMatchObject({ close: 11.5, volume: 195 });
    // nothing changed: no writes
    bars.flush(T0 + 6_000);
    expect(stats.barUpdates).toBe(1);
  });

  test("interval rollover closes the bar; no-trade intervals are gaps", () => {
    const { table, bars } = aggregator(["1s"], 10);
    bars.addTrade("X", 10, 1, T0 + 100);
    bars.addTrade("X", 11, 1, T0 + 999);
    // next trade 3.5s later: 1s and 2s have no trades
    bars.addTrade("X", 12, 1, T0 + 3_500);
    bars.flush(T0 + 3_500);
    expect(table.get(barKey("X", "1s", T0))).toMatchObject({
      open: 10,
      close: 11,
      closed: true,
    });
    expect(table.get(barKey("X", "1s", T0 + 1_000))).toBeUndefined();
    expect(table.get(barKey("X", "1s", T0 + 2_000))).toBeUndefined();
    expect(table.get(barKey("X", "1s", T0 + 3_000))).toMatchObject({
      open: 12,
      closed: false,
    });
    // the publish cycle closes a bar once its interval has ended
    bars.flush(T0 + 4_000);
    expect(table.get(barKey("X", "1s", T0 + 3_000))?.closed).toBe(true);
    // a trade stamped before the end of a closed bar opens the next one
    bars.addTrade("X", 13, 1, T0 + 3_900);
    bars.flush(T0 + 4_000);
    expect(table.get(barKey("X", "1s", T0 + 4_000))).toMatchObject({
      open: 13,
      closed: false,
    });
    expect(table.get(barKey("X", "1s", T0 + 3_000))?.trades).toBe(1);
  });

  test("rolling window keeps `history` closed bars plus the current one", () => {
    const { table, bars, stats } = aggregator(["1s", "1m"], 3);
    for (let i = 0; i < 10; i++) bars.addTrade("X", 10 + i, 1, T0 + i * 1_000);
    bars.flush(T0 + 9_500);
    const ones = table.all().filter((r) => r.interval === "1s");
    expect(ones.map((r) => r.start)).toEqual(
      [6, 7, 8, 9].map((i) => T0 + i * 1_000),
    );
    expect(ones.filter((r) => !r.closed).length).toBe(1);
    // evicted before ever being written: no delete needed
    expect(stats.barEvictions).toBe(0);
    bars.addTrade("X", 30, 1, T0 + 10_000);
    bars.flush(T0 + 10_000);
    expect(stats.barEvictions).toBe(1);
    expect(table.get(barKey("X", "1s", T0 + 6_000))).toBeUndefined();
    // 1m: one bar holding all eleven trades
    expect(table.get(barKey("X", "1m", T0))).toMatchObject({
      open: 10,
      high: 30,
      low: 10,
      close: 30,
      trades: 11,
    });
    // once closed, the window holds `history` bars
    bars.flush(T0 + 11_000);
    expect(bars.barsOf("X", "1s").length).toBe(3);
  });

  test("backfill seeds closed history before the live bars", () => {
    const { table, bars } = aggregator(["1m"], 3);
    bars.backfill("X", "1m", [
      {
        start: T0 - 120_000,
        open: 1,
        high: 2,
        low: 1,
        close: 2,
        volume: 10,
        turnover: 15,
        trades: 2,
      },
      {
        start: T0 - 60_000,
        open: 2,
        high: 3,
        low: 2,
        close: 3,
        volume: 10,
        turnover: 25,
        trades: 2,
      },
    ]);
    bars.addTrade("X", 4, 5, T0 + 1);
    bars.flush(T0 + 1);
    expect(table.get(barKey("X", "1m", T0 - 60_000))).toMatchObject({
      closed: true,
      backfilled: true,
      vwap: 2.5,
    });
    expect(table.get(barKey("X", "1m", T0))).toMatchObject({
      backfilled: false,
      closed: false,
    });
    expect(() => bars.backfill("X", "5m", [])).toThrow();
  });
});

describe("bar backfill", () => {
  test("aligned, closed, on tick, inside the band, ending at the current interval", () => {
    const sim = createExchangeSimulator({
      clock: () => T0 + 30_000,
      config: { instruments: "AAPL.OQ" },
    });
    const book = sim.getBook("AAPL.OQ");
    if (!book) throw Error("no book");
    const history = generateBackfillBars({
      model: book.model,
      lotSize: 1,
      tradeSize: 100,
      takerRate: 8,
      timeScale: 10,
      intervalMs: 60_000,
      count: 200,
      now: T0 + 30_000,
      rng: new Random(1),
    });
    expect(history.length).toBe(200);
    expect(history.at(-1)?.start).toBe(T0 - 60_000);
    for (const [i, bar] of history.entries()) {
      expect(bar.start % 60_000).toBe(0);
      if (i > 0) {
        expect(bar.start - history[i - 1].start).toBe(60_000);
        // continuous: each bar opens at the previous close
        expect(bar.open).toBe(history[i - 1].close);
      }
      expect(bar.high).toBeGreaterThanOrEqual(Math.max(bar.open, bar.close));
      expect(bar.low).toBeLessThanOrEqual(Math.min(bar.open, bar.close));
      expect(book.model.isWithinBand(bar.low)).toBe(true);
      expect(book.model.isWithinBand(bar.high)).toBe(true);
      expect(roundToTick(bar.close, book.schedule)).toBe(bar.close);
      expect(bar.trades).toBeGreaterThan(0);
      expect(bar.volume).toBeGreaterThan(0);
    }
    // the last close is where the price model is now
    expect(history.at(-1)?.close).toBe(book.model.fairOnTick);
    // lively: 1m candles at timeScale 10 move
    const moved = history.filter((b) => b.high > b.low).length;
    expect(moved).toBeGreaterThan(150);
  });

  test("simulator backfills every series without disturbing the live market", () => {
    const run = (barBackfill: number) => {
      const clock = new ManualClock(T0);
      const sim = createExchangeSimulator({
        clock: clock.now,
        config: { instruments: "AAPL.OQ,VOD.L", barHistory: 50, barBackfill },
      });
      const tables = createFakeTables();
      sim.attachTables(tables);
      for (let i = 0; i < 100; i++) {
        clock.advance(20);
        sim.step();
      }
      sim.flush();
      return { tables, sim };
    };
    const off = run(0);
    const on = run(1);
    // same seed: identical trades either way
    expect(on.tables.trades.all()).toEqual(off.tables.trades.all());
    const backfilled = on.tables.bars.all().filter((r) => r.backfilled);
    for (const ric of ["AAPL.OQ", "VOD.L"]) {
      for (const interval of ["1s", "1m", "5m"]) {
        const series = backfilled.filter(
          (r) => r.ric === ric && r.interval === interval,
        );
        expect(series.length).toBeGreaterThan(40);
        expect(series.length).toBeLessThanOrEqual(50);
        expect(series.every((r) => r.closed)).toBe(true);
      }
    }
    expect(off.tables.bars.all().some((r) => r.backfilled)).toBe(false);
  });
});

describe("bars from the simulator", () => {
  test("live bars match the trades table", () => {
    const { clock, sim, tables } = quietSim({
      mmRate: 10,
      takerRate: 20,
    });
    for (let i = 0; i < 400; i++) {
      clock.advance(20);
      sim.step();
      if (i % 5 === 0) sim.flush();
    }
    sim.flush();
    const trades = tables.trades.all();
    expect(trades.length).toBeGreaterThan(20);
    for (const interval of ["1s", "1m", "5m"]) {
      const bars = tables.bars.all().filter((r) => r.interval === interval);
      const ms = parseBarInterval(interval);
      expect(bars.reduce((n, r) => n + (r.volume as number), 0)).toBe(
        trades.reduce((n, r) => n + (r.size as number), 0),
      );
      expect(bars.reduce((n, r) => n + (r.trades as number), 0)).toBe(
        trades.length,
      );
      for (const bar of bars) {
        const inBar = trades.filter(
          (t) =>
            (t.timestamp as number) >= (bar.start as number) &&
            (t.timestamp as number) < (bar.start as number) + ms,
        );
        const prices = inBar.map((t) => t.price as number);
        expect(bar.high).toBe(Math.max(...prices));
        expect(bar.low).toBe(Math.min(...prices));
        expect(bar.open).toBe(prices[0]);
        expect(bar.close).toBe(prices.at(-1) as number);
      }
    }
  });

  test("an explicit trade shows in each interval; empty barIntervals disables bars", () => {
    const { tables, trade, sim } = quietSim();
    trade(170, 10);
    sim.flush();
    for (const interval of ["1s", "1m", "5m"]) {
      const start =
        Math.floor(T0 / parseBarInterval(interval)) *
        parseBarInterval(interval);
      expect(tables.bars.get(barKey("AAPL.OQ", interval, start))).toMatchObject(
        {
          open: 170,
          close: 170,
          volume: 10,
          vwap: 170,
          trades: 1,
        },
      );
    }
    const off = quietSim({ barIntervals: "" });
    off.trade(170, 10);
    off.sim.flush();
    expect(off.sim.publisher?.bars).toBeUndefined();
    expect(off.tables.bars.rowCount).toBe(0);
  });
});

describe("bookSamples", () => {
  test("periodic, aligned samples of the published top of book", () => {
    const { clock, sim, tables, limit } = quietSim({ bookSampleHistory: 3 });
    // empty book: no sample
    expect(tables.bookSamples.rowCount).toBe(0);
    limit(BookSide.BUY, 99, 100);
    limit(BookSide.BUY, 98, 300);
    limit(BookSide.SELL, 101, 200);
    clock.advance(1_000);
    sim.flush();
    const time = T0 + 1_000;
    expect(
      tables.bookSamples.get(bookSampleKey("AAPL.OQ", time)),
    ).toMatchObject({
      ric: "AAPL.OQ",
      time,
      bid: 99,
      ask: 101,
      mid: 100,
      spreadBps: 200,
      bidSize: 100,
      askSize: 200,
      bidDepth: 400,
      askDepth: 200,
      imbalance: Math.round((200 / 600) * 1e4) / 1e4,
      bidPx0: 99,
      bidSz0: 100,
      bidPx1: 98,
      bidSz1: 300,
      askPx0: 101,
      askSz0: 200,
      askPx1: null,
      askSz1: 0,
    });
    // more flushes inside the same interval: no new sample
    clock.advance(400);
    sim.flush();
    expect(tables.bookSamples.rowCount).toBe(1);
    // rolling window of 3
    for (let i = 0; i < 5; i++) {
      clock.advance(1_000);
      sim.flush();
    }
    const kept = tables.bookSamples.all().map((r) => r.time);
    expect(kept).toEqual([T0 + 4_000, T0 + 5_000, T0 + 6_000]);
  });

  test("bidDepth / askDepth cover only the top 5 levels", () => {
    const { clock, sim, tables, limit } = quietSim({ depthLevels: 10 });
    for (let i = 0; i < 7; i++) limit(BookSide.BUY, 99 - i, 10 * (i + 1));
    limit(BookSide.SELL, 101, 5);
    clock.advance(1_000);
    sim.flush();
    expect(
      tables.bookSamples.get(bookSampleKey("AAPL.OQ", T0 + 1_000)),
    ).toMatchObject({
      bidDepth: 10 + 20 + 30 + 40 + 50,
      askDepth: 5,
      bidPx4: 95,
      bidSz4: 50,
    });
  });

  test("bookSampleIntervalMs 0 disables sampling", () => {
    const { sim, tables, limit, clock } = quietSim({ bookSampleIntervalMs: 0 });
    limit(BookSide.BUY, 99, 100);
    clock.advance(5_000);
    sim.flush();
    expect(sim.publisher?.bookSamples).toBeUndefined();
    expect(tables.bookSamples.rowCount).toBe(0);
  });
});

describe("chart data config", () => {
  test("defaults, env and validation", () => {
    expect(loadExchangeSimConfig(undefined, {})).toMatchObject({
      barIntervals: "1s,1m,5m",
      barHistory: 500,
      barBackfill: 1,
      bookSampleIntervalMs: 1_000,
      bookSampleHistory: 300,
    });
    expect(
      loadExchangeSimConfig(undefined, {
        EXCHANGE_SIM_BAR_INTERVALS: "5s,1h",
        EXCHANGE_SIM_BAR_BACKFILL: "0",
      }),
    ).toMatchObject({ barIntervals: "5s,1h", barBackfill: 0 });
    const bad = (overrides: object) => () =>
      loadExchangeSimConfig(undefined, {}, overrides);
    expect(bad({ barIntervals: "1x" })).toThrow(/barIntervals/);
    expect(bad({ barIntervals: "1m,1m" })).toThrow(/duplicates/);
    expect(bad({ barHistory: 0 })).toThrow(/barHistory/);
    expect(bad({ barBackfill: 2 })).toThrow(/barBackfill/);
    expect(bad({ bookSampleIntervalMs: -1 })).toThrow(/bookSampleIntervalMs/);
    expect(bad({ bookSampleHistory: 1.5 })).toThrow(/bookSampleHistory/);
    expect(bad({ barIntervals: "" })()).toMatchObject({ barIntervals: "" });
  });
});
