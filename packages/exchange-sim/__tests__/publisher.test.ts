import { describe, expect, test } from "bun:test";
import { Side as BookSide } from "@heswell/hft-limit-order-book";
import {
  depthKey,
  RejectReason,
  Side,
  TradingPhase,
} from "@heswell/trading-schemas";
import { createExchangeSimulator } from "../src/engine/ExchangeSimulator";
import { handleExchangeAdminRpc } from "../src/modules/exchange/ExchangeAdminService";
import { TradeRingBuffer } from "../src/publish/TradeRingBuffer";
import { ALL_INSTRUMENTS } from "../src/reference/instruments";
import { ManualClock } from "../src/util/clock";
import { createFakeTables } from "./fakeTables";

/** One instrument, bots paused: the test drives the book directly. */
const quietSim = (config = {}) => {
  const clock = new ManualClock();
  const sim = createExchangeSimulator({
    clock: clock.now,
    config: {
      instruments: "AAPL.OQ",
      mmRate: 0,
      takerRate: 0,
      ...config,
    },
  });
  const tables = createFakeTables();
  sim.attachTables(tables);
  const book = sim.getBook("AAPL.OQ");
  if (!book) throw Error("no book");
  let n = 0;
  const limit = (side: BookSide, price: number, size: number) => {
    const id = `t${++n}`;
    book.limit({ id, side, price, size });
    return id;
  };
  return { clock, sim, tables, book, limit };
};

describe("TradeRingBuffer", () => {
  test("evicts oldest once full", () => {
    const ring = new TradeRingBuffer(3);
    expect(ring.push("a")).toBeUndefined();
    expect(ring.push("b")).toBeUndefined();
    expect(ring.push("c")).toBeUndefined();
    expect(ring.push("d")).toBe("a");
    expect(ring.push("e")).toBe("b");
    expect(ring.toArray()).toEqual(["c", "d", "e"]);
    expect(ring.size).toBe(3);
    expect(() => new TradeRingBuffer(0)).toThrow();
  });
});

describe("MarketDataPublisher", () => {
  test("loads instruments for the whole universe and CLOSED prices for inactive", () => {
    const { tables } = quietSim();
    expect(tables.instruments.rowCount).toBe(ALL_INSTRUMENTS.length);
    expect(tables.instruments.get("AAPL.OQ")?.simulated).toBe(true);
    const vod = tables.instruments.get("VOD.L");
    expect(vod?.simulated).toBe(false);
    expect(vod?.currency).toBe("GBX");
    expect(tables.prices.rowCount).toBe(ALL_INSTRUMENTS.length);
    expect(tables.prices.get("VOD.L")?.phase).toBe(TradingPhase.Closed);
    expect(tables.prices.get("AAPL.OQ")?.phase).toBe(TradingPhase.Continuous);
  });

  test("publishes depth as deltas and deletes vanished levels", () => {
    const { sim, tables, book, limit } = quietSim();
    const depth = tables.depth;
    const ids = [
      limit(BookSide.BUY, 100, 10),
      limit(BookSide.BUY, 99.9, 20),
      limit(BookSide.BUY, 99.9, 5),
      limit(BookSide.SELL, 100.1, 7),
    ];
    depth.resetCounts();
    sim.flush();
    expect(depth.inserts).toBe(3);
    const l1 = depth.get(depthKey("AAPL.OQ", Side.Buy, 1));
    expect(l1).toMatchObject({
      ric: "AAPL.OQ",
      side: Side.Buy,
      level: 1,
      price: 99.9,
      size: 25,
      cumSize: 35,
      orderCount: 2,
    });
    expect(l1?.seq).toBe(book.seq);

    // nothing changed: nothing published
    depth.resetCounts();
    sim.flush();
    expect(depth.ops).toBe(0);

    // size change on level 0 updates level 0 and the cumSize of level 1 only
    book.modify(ids[0], { size: 4 });
    depth.resetCounts();
    sim.flush();
    expect(depth.inserts).toBe(0);
    expect(depth.updates).toBe(2);
    expect(depth.get(depthKey("AAPL.OQ", Side.Buy, 1))?.cumSize).toBe(29);

    // level 0 vanishes: levels shift up and the old last level is deleted
    book.cancel(ids[0]);
    depth.resetCounts();
    sim.flush();
    expect(depth.deletes).toBe(1);
    expect(depth.get(depthKey("AAPL.OQ", Side.Buy, 1))).toBeUndefined();
    expect(depth.get(depthKey("AAPL.OQ", Side.Buy, 0))?.price).toBe(99.9);

    // empty side
    book.cancel(ids[3]);
    sim.flush();
    expect(depth.get(depthKey("AAPL.OQ", Side.Sell, 0))).toBeUndefined();
    expect(depth.rowCount).toBe(1);
  });

  test("limits depth to depthLevels", () => {
    const { sim, tables, limit } = quietSim({ depthLevels: 3 });
    for (let i = 0; i < 6; i++) limit(BookSide.SELL, 101 + i, 1);
    sim.flush();
    expect(tables.depth.rowCount).toBe(3);
    expect(tables.depth.get(depthKey("AAPL.OQ", Side.Sell, 2))?.cumSize).toBe(
      3,
    );
  });

  test("coalesces prices per flush with session stats", () => {
    const { sim, tables, book, limit, clock } = quietSim();
    limit(BookSide.SELL, 100.1, 50);
    limit(BookSide.BUY, 99.9, 50);
    for (let i = 0; i < 5; i++) {
      book.market({ id: `m${i}`, side: BookSide.BUY, size: 2 });
    }
    book.limit({ id: "x", side: BookSide.SELL, price: 99.9, size: 4 });
    tables.prices.resetCounts();
    clock.advance(5);
    sim.flush();
    expect(tables.prices.updates).toBe(1);
    const instrument = sim.getInstrument("AAPL.OQ");
    const row = tables.prices.get("AAPL.OQ");
    expect(row).toMatchObject({
      bid: 99.9,
      bidSize: 46,
      ask: 100.1,
      askSize: 40,
      last: 99.9,
      lastSize: 4,
      open: 100.1,
      high: 100.1,
      low: 99.9,
      volume: 14,
      close: instrument?.refPrice,
      phase: TradingPhase.Continuous,
      timestamp: clock.now(),
    });
    expect(row?.turnover).toBeCloseTo(10 * 100.1 + 4 * 99.9, 6);
    expect(row?.vwap).toBeCloseTo((10 * 100.1 + 4 * 99.9) / 14, 4);
    const refPrice = instrument?.refPrice ?? 0;
    expect(row?.change).toBeCloseTo(99.9 - refPrice, 6);
    expect(row?.changePct).toBeCloseTo((100 * (99.9 - refPrice)) / refPrice, 3);
  });

  test("appends trades to the tape and evicts beyond capacity", () => {
    const { sim, tables, book, limit } = quietSim({ tradesCapacity: 4 });
    limit(BookSide.SELL, 100.1, 100);
    for (let i = 0; i < 6; i++) {
      book.market({ id: `m${i}`, side: BookSide.BUY, size: 1 });
    }
    sim.flush();
    expect(tables.trades.rowCount).toBe(4);
    const ids = tables.trades.all().map(({ tradeId }) => tradeId);
    expect(ids.sort()).toEqual([
      "TR000000003",
      "TR000000004",
      "TR000000005",
      "TR000000006",
    ]);
    expect(tables.trades.get("TR000000006")).toMatchObject({
      ric: "AAPL.OQ",
      price: 100.1,
      size: 1,
      aggressorSide: Side.Buy,
    });
    expect(sim.publisher?.stats.tradeEvictions).toBe(2);
  });

  test("publishes a live simulation with bounded updates per flush", () => {
    const clock = new ManualClock();
    const sim = createExchangeSimulator({
      clock: clock.now,
      config: { activeInstruments: 20 },
    });
    const tables = createFakeTables();
    sim.attachTables(tables);
    for (let t = 0; t < 2_000; t += 20) {
      sim.step(clock.advance(20));
      if (t % 100 === 0) sim.flush(clock.now());
    }
    sim.flush();
    for (const book of sim.books) {
      const row = tables.prices.get(book.ric);
      expect(row?.bid).toBeGreaterThan(0);
      expect(row?.ask).toBeGreaterThan(row?.bid as number);
    }
    // at most 20 levels per book in depth table
    expect(tables.depth.rowCount).toBeLessThanOrEqual(20 * 20);
    expect(tables.trades.rowCount).toBe(sim.tradeCount);
  });
});

describe("admin RPCs", () => {
  test("setVolatility for one or all instruments", () => {
    const { sim } = quietSim({ instruments: "AAPL.OQ,VOD.L" });
    expect(
      handleExchangeAdminRpc(sim, "setVolatility", {
        ric: "VOD.L",
        volatility: 0.9,
      }),
    ).toEqual({ type: "SUCCESS_RESULT", data: { rics: ["VOD.L"] } });
    expect(sim.getBook("VOD.L")?.model.volatility).toBe(0.9);
    const all = handleExchangeAdminRpc(sim, "setVolatility", {
      volatility: 0.1,
    });
    expect(all).toEqual({
      type: "SUCCESS_RESULT",
      data: { rics: ["AAPL.OQ", "VOD.L"] },
    });
    expect(sim.getBook("AAPL.OQ")?.model.volatility).toBe(0.1);
  });

  test("validates params and reports contract-shaped errors", () => {
    const { sim } = quietSim();
    expect(
      handleExchangeAdminRpc(sim, "setVolatility", { volatility: -1 }),
    ).toMatchObject({
      type: "ERROR_RESULT",
      errorMessage: expect.stringMatching(/^INVALID_REQUEST: /),
    });
    expect(
      handleExchangeAdminRpc(sim, "haltInstrument", { ric: "NOPE.X" }),
    ).toEqual({
      type: "ERROR_RESULT",
      errorMessage: `${RejectReason.UnknownInstrument}: unknown instrument NOPE.X`,
    });
    expect(
      handleExchangeAdminRpc(sim, "haltInstrument", { ric: "VOD.L" }),
    ).toEqual({
      type: "ERROR_RESULT",
      errorMessage: `${RejectReason.UnknownInstrument}: VOD.L is not simulated`,
    });
    expect(
      handleExchangeAdminRpc(sim, "setBotRate", { bot: "ROBOT", rate: 1 }),
    ).toMatchObject({ type: "ERROR_RESULT" });
  });

  test("halt and resume change phase, stop bots and publish", () => {
    const clock = new ManualClock();
    const sim = createExchangeSimulator({
      clock: clock.now,
      config: { instruments: "AAPL.OQ" },
    });
    const tables = createFakeTables();
    sim.attachTables(tables);
    const book = sim.getBook("AAPL.OQ");
    if (!book) throw Error();
    for (let t = 0; t < 500; t += 20) sim.step(clock.advance(20));
    expect(
      handleExchangeAdminRpc(sim, "haltInstrument", {
        ric: "AAPL.OQ",
        reason: "news pending",
      }),
    ).toEqual({ type: "SUCCESS_RESULT", data: { rics: ["AAPL.OQ"] } });
    expect(book.phase).toBe(TradingPhase.Halted);
    expect(book.haltReason).toBe("news pending");
    expect(tables.prices.get("AAPL.OQ")?.phase).toBe(TradingPhase.Halted);
    const events = book.events;
    for (let t = 0; t < 2_000; t += 20) sim.step(clock.advance(20));
    expect(book.events).toBe(events);
    // idempotent
    expect(
      handleExchangeAdminRpc(sim, "haltInstrument", { ric: "AAPL.OQ" }).type,
    ).toBe("SUCCESS_RESULT");
    expect(
      handleExchangeAdminRpc(sim, "resumeInstrument", {
        ric: "AAPL.OQ",
        auction: true,
      }),
    ).toMatchObject({
      type: "ERROR_RESULT",
      errorMessage: expect.stringMatching(/^INVALID_REQUEST/),
    });
    expect(
      handleExchangeAdminRpc(sim, "resumeInstrument", { ric: "AAPL.OQ" }),
    ).toEqual({ type: "SUCCESS_RESULT", data: { rics: ["AAPL.OQ"] } });
    expect(tables.prices.get("AAPL.OQ")?.phase).toBe(TradingPhase.Continuous);
    for (let t = 0; t < 500; t += 20) sim.step(clock.advance(20));
    expect(book.events).toBeGreaterThan(events);
  });

  test("setBotRate per bot type", () => {
    const { sim } = quietSim({ instruments: "AAPL.OQ,VOD.L" });
    expect(
      handleExchangeAdminRpc(sim, "setBotRate", {
        ric: "VOD.L",
        bot: "MARKET_MAKER",
        rate: 3,
      }),
    ).toEqual({ type: "SUCCESS_RESULT", data: { rics: ["VOD.L"] } });
    expect(sim.getSimulated("VOD.L")).toMatchObject({
      mmRate: 3,
      takerRate: 0,
    });
    handleExchangeAdminRpc(sim, "setBotRate", { rate: 7 });
    expect(sim.getSimulated("AAPL.OQ")).toMatchObject({
      mmRate: 7,
      takerRate: 7,
    });
  });
});
