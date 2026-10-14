import { describe, expect, test } from "bun:test";
import { Side as BookSide } from "@heswell/hft-limit-order-book";
import {
  ExecType,
  Liquidity,
  OrdStatus,
  OrdType,
  RejectReason,
  Side,
  TimeInForce,
  TradingPhase,
} from "@heswell/trading-schemas";
import { createExchangeSimulator } from "../src/engine/ExchangeSimulator";
import type { ExecutionReport, GatewayNewOrder } from "../src/gateway/types";
import { ManualClock } from "../src/util/clock";
import { createFakeTables } from "./fakeTables";

const RIC = "AAPL.OQ";

const setup = () => {
  const clock = new ManualClock();
  const sim = createExchangeSimulator({
    clock: clock.now,
    config: { instruments: `${RIC},VOD.L`, mmRate: 0, takerRate: 0 },
  });
  const book = sim.getBook(RIC);
  if (!book) throw Error();
  const reports: ExecutionReport[] = [];
  const gw = sim.gateway;
  gw.onExecutionReport((report) => reports.push(report));
  let n = 0;
  /** Resting liquidity from a "bot" (not the gateway). */
  const rest = (side: BookSide, price: number, size: number) =>
    book.limit({ id: `bot${++n}`, side, price, size });
  let cl = 0;
  const order = (o: Partial<GatewayNewOrder> = {}): GatewayNewOrder => ({
    account: "ACC1",
    clOrdId: `c${++cl}`,
    ric: RIC,
    side: Side.Buy,
    ordType: OrdType.Limit,
    quantity: 100,
    price: 170,
    ...o,
  });
  const take = () => reports.splice(0);
  return { clock, sim, book, gw, rest, order, take };
};

describe("SimExchangeGateway", () => {
  test("acks a resting limit order and exposes it in the book", () => {
    const { gw, book, order, take } = setup();
    const id = gw.submit(order());
    const [ack, ...rest] = take();
    expect(rest).toHaveLength(0);
    expect(ack).toMatchObject({
      execType: ExecType.New,
      ordStatus: OrdStatus.New,
      responseTo: "NEW",
      exchangeOrderId: id,
      clOrdId: "c1",
      account: "ACC1",
      leavesQty: 100,
      cumQty: 0,
      price: 170,
      timeInForce: TimeInForce.Day,
    });
    expect(ack.execId).toMatch(/^E\d+$/);
    const resting = book.book.order(id);
    expect(resting?.accountId).toBe("ACC1");
    expect(gw.getOrder(id)?.ordStatus).toBe(OrdStatus.New);
    expect(gw.getTopOfBook(RIC)).toMatchObject({ bid: 170, bidSize: 100 });
  });

  test("aggressive limit fills against the book (REMOVED) with trade ids", () => {
    const { sim, gw, rest, order, take } = setup();
    const tape: string[] = [];
    sim.onTape(({ tradeId }) => tape.push(tradeId));
    rest(BookSide.SELL, 170, 30);
    rest(BookSide.SELL, 170.01, 50);
    const id = gw.submit(order({ price: 170.01 }));
    const reports = take();
    expect(reports.map(({ execType }) => execType)).toEqual([
      ExecType.New,
      ExecType.Trade,
      ExecType.Trade,
    ]);
    expect(reports[1]).toMatchObject({
      exchangeOrderId: id,
      ordStatus: OrdStatus.PartiallyFilled,
      lastQty: 30,
      lastPx: 170,
      cumQty: 30,
      leavesQty: 70,
      liquidity: Liquidity.Removed,
      tradeId: tape[0],
    });
    expect(reports[2]).toMatchObject({
      ordStatus: OrdStatus.PartiallyFilled,
      lastQty: 50,
      lastPx: 170.01,
      cumQty: 80,
      leavesQty: 20,
      tradeId: tape[1],
    });
    expect(reports[2].avgPx).toBeCloseTo((30 * 170 + 50 * 170.01) / 80, 8);
  });

  test("resting order filled later by other flow (ADDED)", () => {
    const { gw, book, order, take } = setup();
    const id = gw.submit(order({ quantity: 40 }));
    take();
    book.market({ id: "bot-mkt", side: BookSide.SELL, size: 40 });
    const [fill, ...others] = take();
    expect(others).toHaveLength(0);
    expect(fill).toMatchObject({
      exchangeOrderId: id,
      execType: ExecType.Trade,
      ordStatus: OrdStatus.Filled,
      liquidity: Liquidity.Added,
      lastQty: 40,
      leavesQty: 0,
    });
    expect(fill.responseTo).toBeUndefined();
    expect(gw.getOrder(id)?.ordStatus).toBe(OrdStatus.Filled);
  });

  test("two gateway orders trading with each other both get fills", () => {
    const { gw, order, take } = setup();
    const sell = gw.submit(
      order({ account: "ACC2", side: Side.Sell, quantity: 10 }),
    );
    const buy = gw.submit(order({ quantity: 10 }));
    const fills = take().filter(({ execType }) => execType === ExecType.Trade);
    expect(fills).toHaveLength(2);
    const byId = Object.fromEntries(fills.map((f) => [f.exchangeOrderId, f]));
    expect(byId[sell]).toMatchObject({
      liquidity: Liquidity.Added,
      ordStatus: OrdStatus.Filled,
    });
    expect(byId[buy]).toMatchObject({
      liquidity: Liquidity.Removed,
      ordStatus: OrdStatus.Filled,
    });
    expect(byId[sell].tradeId).toBe(byId[buy].tradeId);
  });

  test("market order: fill then expiry of the unfilled remainder", () => {
    const { gw, rest, order, take } = setup();
    rest(BookSide.SELL, 170, 30);
    gw.submit(
      order({
        ordType: OrdType.Market,
        price: undefined,
        timeInForce: TimeInForce.ImmediateOrCancel,
      }),
    );
    expect(
      take().map(({ execType, ordStatus }) => [execType, ordStatus]),
    ).toEqual([
      [ExecType.New, OrdStatus.New],
      [ExecType.Trade, OrdStatus.PartiallyFilled],
      [ExecType.Expired, OrdStatus.Expired],
    ]);
  });

  test("IOC limit expires its remainder; FOK not fillable expires untouched", () => {
    const { gw, rest, order, take, book } = setup();
    rest(BookSide.SELL, 170, 30);
    const ioc = gw.submit(
      order({ timeInForce: TimeInForce.ImmediateOrCancel }),
    );
    const iocReports = take();
    expect(iocReports.at(-1)).toMatchObject({
      execType: ExecType.Expired,
      cumQty: 30,
      leavesQty: 0,
    });
    expect(book.book.order(ioc)).toBeUndefined();

    rest(BookSide.SELL, 170, 30);
    gw.submit(order({ timeInForce: TimeInForce.FillOrKill }));
    const fok = take();
    expect(fok.map(({ execType }) => execType)).toEqual([
      ExecType.New,
      ExecType.Expired,
    ]);
    expect(fok[1].rejectReason).toBe(RejectReason.FokNotFillable);
    expect(book.topOfBook().askSize).toBe(30);
  });

  test("rejects invalid orders with reason codes", () => {
    const { sim, gw, order, take } = setup();
    const cases: [Partial<GatewayNewOrder>, RejectReason][] = [
      [{ account: "" }, RejectReason.InvalidRequest],
      [{ ric: "NOPE.X" }, RejectReason.UnknownInstrument],
      [{ price: 170.005 }, RejectReason.InvalidTickSize],
      [{ quantity: 0 }, RejectReason.InvalidQuantity],
      [{ price: undefined }, RejectReason.MissingPrice],
      [{ price: 1 }, RejectReason.PriceOutsideCollar],
    ];
    for (const [patch, reason] of cases) {
      gw.submit(order(patch));
      const [report, ...rest] = take();
      expect(rest).toHaveLength(0);
      expect({
        patch,
        execType: report.execType,
        ordStatus: report.ordStatus,
        reason: report.rejectReason,
      }).toEqual({
        patch,
        execType: ExecType.Rejected,
        ordStatus: OrdStatus.Rejected,
        reason,
      });
    }
    gw.submit(order({ clOrdId: "dup" }));
    gw.submit(order({ clOrdId: "dup" }));
    expect(take()[1].rejectReason).toBe(RejectReason.DuplicateClOrdId);
    // same clOrdId on another account is fine
    gw.submit(order({ clOrdId: "dup", account: "ACC9" }));
    expect(take()[0].execType).toBe(ExecType.New);

    // listed but not simulated
    const inactive = sim.universe.find(({ ric }) => !sim.isSimulated(ric));
    gw.submit(order({ ric: inactive?.ric, price: inactive?.refPrice }));
    expect(take()[0].rejectReason).toBe(RejectReason.MarketClosed);

    sim.haltInstrument(RIC);
    gw.submit(order());
    expect(take()[0].rejectReason).toBe(RejectReason.InstrumentHalted);
    expect(gw.getPhase(RIC)).toBe(TradingPhase.Halted);
  });

  test("amend: replace price/qty, reduce to cumQty, rejects", () => {
    const { sim, gw, book, order, take } = setup();
    const id = gw.submit(order());
    take();
    gw.amend(id, { price: 169.5, quantity: 120, clOrdId: "c1a" });
    expect(take()).toEqual([
      expect.objectContaining({
        execType: ExecType.Replaced,
        ordStatus: OrdStatus.Replaced,
        responseTo: "AMEND",
        clOrdId: "c1a",
        price: 169.5,
        quantity: 120,
        leavesQty: 120,
      }),
    ]);
    expect(book.book.order(id)).toMatchObject({ price: 169.5, size: 120 });

    gw.amend(id, { price: 169.501 });
    expect(take()[0]).toMatchObject({
      execType: ExecType.Rejected,
      ordStatus: OrdStatus.Replaced,
      rejectReason: RejectReason.InvalidTickSize,
    });
    // a rejected amend doesn't change the order
    expect(gw.getOrder(id)?.price).toBe(169.5);

    // partial fill then reduce quantity to cumQty -> done
    book.market({ id: "m", side: BookSide.SELL, size: 20 });
    take();
    gw.amend(id, { quantity: 20 });
    expect(take()[0]).toMatchObject({
      execType: ExecType.Replaced,
      ordStatus: OrdStatus.Filled,
      cumQty: 20,
      leavesQty: 0,
    });
    expect(book.book.order(id)).toBeUndefined();
    gw.amend(id, { quantity: 50 });
    expect(take()[0].rejectReason).toBe(RejectReason.TooLateToAmend);
    gw.amend("X999", { quantity: 1 });
    expect(take()[0].rejectReason).toBe(RejectReason.UnknownOrder);

    const id2 = gw.submit(order());
    sim.haltInstrument(RIC);
    take();
    gw.amend(id2, { quantity: 50 });
    expect(take()[0].rejectReason).toBe(RejectReason.InstrumentHalted);
  });

  test("a size-decrease amend keeps queue position; a price amend loses it", () => {
    const { gw, book, rest, order, take } = setup();
    const id = gw.submit(order({ quantity: 100 }));
    rest(BookSide.BUY, 170, 50);
    take();
    const fillFirst = () => {
      book.market({ id: `m${Math.random()}`, side: BookSide.SELL, size: 1 });
      return take();
    };

    gw.amend(id, { quantity: 80 });
    expect(take()[0]).toMatchObject({
      execType: ExecType.Replaced,
      leavesQty: 80,
      priorityKept: true,
    });
    expect(book.book.order(id)).toMatchObject({ price: 170, size: 80 });
    // still at the front of the 170 level: the next sell hits our order
    expect(fillFirst()).toEqual([
      expect.objectContaining({ execType: ExecType.Trade, lastQty: 1 }),
    ]);

    // a price change re-queues at the back of the (new) level
    rest(BookSide.BUY, 169.99, 50);
    gw.amend(id, { price: 169.99 });
    expect(take()[0]).toMatchObject({
      execType: ExecType.Replaced,
      price: 169.99,
      priorityKept: false,
    });
    // the bot at 170 trades first, then the earlier bot at 169.99
    book.market({ id: "m-a", side: BookSide.SELL, size: 100 });
    expect(take()).toEqual([]);
    expect(fillFirst()).toEqual([
      expect.objectContaining({ execType: ExecType.Trade, lastQty: 1 }),
    ]);
    expect(gw.getOrder(id)).toMatchObject({ cumQty: 2, leavesQty: 78 });
  });

  test("a size increase loses priority", () => {
    const { gw, book, rest, order, take } = setup();
    const id = gw.submit(order({ quantity: 10 }));
    rest(BookSide.BUY, 170, 10);
    take();
    gw.amend(id, { quantity: 20 });
    expect(take()[0]).toMatchObject({ leavesQty: 20, priorityKept: false });
    book.market({ id: "m", side: BookSide.SELL, size: 10 });
    expect(take()).toEqual([]);
  });

  test("amend that crosses trades immediately", () => {
    const { gw, rest, order, take } = setup();
    rest(BookSide.SELL, 171, 10);
    const id = gw.submit(order({ quantity: 10 }));
    take();
    gw.amend(id, { price: 171 });
    expect(
      take().map(({ execType, ordStatus }) => [execType, ordStatus]),
    ).toEqual([
      [ExecType.Replaced, OrdStatus.Replaced],
      [ExecType.Trade, OrdStatus.Filled],
    ]);
  });

  test("cancel, also while halted; too late after fill", () => {
    const { sim, gw, book, order, take } = setup();
    const id = gw.submit(order());
    sim.haltInstrument(RIC);
    take();
    gw.cancel(id, { clOrdId: "cx" });
    expect(take()).toEqual([
      expect.objectContaining({
        execType: ExecType.Cancelled,
        ordStatus: OrdStatus.Cancelled,
        responseTo: "CANCEL",
        clOrdId: "cx",
        leavesQty: 0,
      }),
    ]);
    expect(book.book.order(id)).toBeUndefined();
    gw.cancel(id);
    expect(take()[0]).toMatchObject({
      execType: ExecType.Rejected,
      ordStatus: OrdStatus.Cancelled,
      rejectReason: RejectReason.TooLateToCancel,
    });
    gw.cancel("X999");
    expect(take()[0].rejectReason).toBe(RejectReason.TooLateToCancel);
  });

  test("reports are delivered in order even for re-entrant listeners", () => {
    const { gw, rest, order } = setup();
    const seen: string[] = [];
    rest(BookSide.SELL, 170, 10);
    gw.onExecutionReport((report) => {
      seen.push(`${report.clOrdId}:${report.execType}`);
      if (report.clOrdId === "first" && report.execType === ExecType.New) {
        gw.submit(order({ clOrdId: "second", price: 160 }));
      }
    });
    gw.submit(order({ clOrdId: "first", quantity: 10 }));
    expect(seen).toEqual(["first:NEW", "first:TRADE", "second:NEW"]);
  });

  test("bots trade with gateway orders in a live simulation", () => {
    const clock = new ManualClock();
    const sim = createExchangeSimulator({
      clock: clock.now,
      config: { instruments: RIC },
    });
    sim.attachTables(createFakeTables());
    const fills: ExecutionReport[] = [];
    sim.gateway.onExecutionReport((r) => {
      if (r.execType === ExecType.Trade) fills.push(r);
    });
    for (let t = 0; t < 200; t += 20) sim.step(clock.advance(20));
    const { bid } = sim.gateway.getTopOfBook(RIC) ?? { bid: 0 };
    sim.gateway.submit({
      account: "ACC1",
      clOrdId: "1",
      ric: RIC,
      side: Side.Buy,
      ordType: OrdType.Limit,
      quantity: 10,
      price: bid,
    });
    for (let t = 0; t < 60_000 && fills.length === 0; t += 20) {
      sim.step(clock.advance(20));
    }
    expect(fills.length).toBeGreaterThan(0);
    expect(fills[0].liquidity).toBe(Liquidity.Added);
  });
});
