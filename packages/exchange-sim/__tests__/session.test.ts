import { describe, expect, test } from "bun:test";
import {
  ExecType,
  OrdStatus,
  OrdType,
  RejectReason,
  Side,
  TimeInForce,
  TradingPhase,
} from "@heswell/trading-schemas";
import { DEFAULT_CONFIG, loadExchangeSimConfig } from "../src/config";
import { createExchangeSimulator } from "../src/engine/ExchangeSimulator";
import { TradingSession } from "../src/engine/TradingSession";
import type { ExecutionReport, GatewayNewOrder } from "../src/gateway/types";
import { handleExchangeAdminRpc } from "../src/modules/exchange/exchangeAdminRpc";
import { ManualClock } from "../src/util/clock";
import { createFakeTables } from "./fakeTables";

const MIN = 60_000;
const HOUR = 60 * MIN;
/** Midnight UTC, 5 Jan 2026. */
const DAY0 = Date.UTC(2026, 0, 5);
const at = (hh: number, mm = 0) => DAY0 + hh * HOUR + mm * MIN;

const schedule = {
  sessionOpen: "08:00",
  sessionClose: "16:30",
  preOpenMinutes: 30,
  sessionDayMs: 0,
};

describe("TradingSession", () => {
  test("no schedule = always CONTINUOUS", () => {
    const session = new TradingSession(DEFAULT_CONFIG);
    expect(session.scheduled).toBe(false);
    expect(session.phaseAt(at(3))).toBe(TradingPhase.Continuous);
    expect(session.phaseAt(at(23))).toBe(TradingPhase.Continuous);
    expect(session.nextChangeAt(at(3))).toBeUndefined();
  });

  test("CLOSED -> PRE_OPEN -> CONTINUOUS -> CLOSED", () => {
    const session = new TradingSession(schedule);
    expect(session.phaseAt(at(7, 29))).toBe(TradingPhase.Closed);
    expect(session.phaseAt(at(7, 30))).toBe(TradingPhase.PreOpen);
    expect(session.phaseAt(at(7, 59))).toBe(TradingPhase.PreOpen);
    expect(session.phaseAt(at(8))).toBe(TradingPhase.Continuous);
    expect(session.phaseAt(at(16, 29))).toBe(TradingPhase.Continuous);
    expect(session.phaseAt(at(16, 30))).toBe(TradingPhase.Closed);
    expect(session.phaseAt(at(23, 59))).toBe(TradingPhase.Closed);
    expect(session.nextChangeAt(at(3))).toBe(at(7, 30));
    expect(session.nextChangeAt(at(7, 30))).toBe(at(8));
    expect(session.nextChangeAt(at(12))).toBe(at(16, 30));
    expect(session.nextChangeAt(at(16, 30))).toBe(at(24 + 7, 30));
  });

  test("no pre-open and overnight sessions", () => {
    const session = new TradingSession({
      ...schedule,
      sessionOpen: "22:00",
      sessionClose: "06:00",
      preOpenMinutes: 0,
    });
    expect(session.phaseAt(at(21, 59))).toBe(TradingPhase.Closed);
    expect(session.phaseAt(at(23))).toBe(TradingPhase.Continuous);
    expect(session.phaseAt(at(5))).toBe(TradingPhase.Continuous);
    expect(session.phaseAt(at(6))).toBe(TradingPhase.Closed);
    expect(session.nextChangeAt(at(12))).toBe(at(22));
    expect(session.nextChangeAt(at(23))).toBe(at(24 + 6));
  });

  test("sessionDayMs compresses the day (default 08:00-16:30)", () => {
    const session = new TradingSession({
      ...DEFAULT_CONFIG,
      sessionDayMs: 2_400,
    });
    // 2400 ms per day = 100 ms per hour
    expect(session.scheduled).toBe(true);
    expect(session.phaseAt(DAY0 + 799)).toBe(TradingPhase.Closed);
    expect(session.phaseAt(DAY0 + 800)).toBe(TradingPhase.Continuous);
    expect(session.phaseAt(DAY0 + 1_649)).toBe(TradingPhase.Continuous);
    expect(session.phaseAt(DAY0 + 1_650)).toBe(TradingPhase.Closed);
    expect(session.phaseAt(DAY0 + 2_400 + 900)).toBe(TradingPhase.Continuous);
    expect(session.nextChangeAt(DAY0)).toBe(DAY0 + 800);
    expect(session.nextChangeAt(DAY0 + 900)).toBe(DAY0 + 1_650);
  });

  test("config validation and env loading", () => {
    const load = (env: Record<string, string>) =>
      loadExchangeSimConfig(undefined, env);
    expect(
      load({
        EXCHANGE_SIM_SESSION_OPEN: "08:00",
        EXCHANGE_SIM_SESSION_CLOSE: "16:30",
        EXCHANGE_SIM_PRE_OPEN_MINUTES: "15",
        EXCHANGE_SIM_SESSION_DAY_MS: "120000",
      }),
    ).toMatchObject({
      sessionOpen: "08:00",
      sessionClose: "16:30",
      preOpenMinutes: 15,
      sessionDayMs: 120_000,
    });
    expect(() => load({ EXCHANGE_SIM_SESSION_OPEN: "08:00" })).toThrow(
      /set together/,
    );
    expect(() =>
      load({
        EXCHANGE_SIM_SESSION_OPEN: "8am",
        EXCHANGE_SIM_SESSION_CLOSE: "16:30",
      }),
    ).toThrow(/HH:MM/);
    expect(() =>
      load({
        EXCHANGE_SIM_SESSION_OPEN: "08:00",
        EXCHANGE_SIM_SESSION_CLOSE: "08:00",
      }),
    ).toThrow(/differ/);
    expect(() => load({ EXCHANGE_SIM_SESSION_DAY_MS: "-1" })).toThrow();
  });
});

const RIC = "AAPL.OQ";

const sessionSim = (start: number, config = {}) => {
  const clock = new ManualClock(start);
  const sim = createExchangeSimulator({
    clock: clock.now,
    config: { instruments: `${RIC},VOD.L`, ...schedule, ...config },
  });
  const tables = createFakeTables();
  sim.attachTables(tables);
  const book = sim.getBook(RIC);
  if (!book) throw Error();
  const reports: ExecutionReport[] = [];
  sim.gateway.onExecutionReport((r) => reports.push(r));
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
  /** step every `stepMs` up to `until`, then flush. */
  const runTo = (until: number, stepMs = 20) => {
    while (clock.time < until) {
      sim.step(clock.advance(Math.min(stepMs, until - clock.time)));
    }
    sim.flush();
  };
  const take = () => reports.splice(0);
  const phase = (ric = RIC) => tables.prices.get(ric)?.phase;
  return { clock, sim, tables, book, order, runTo, take, phase };
};

describe("ExchangeSimulator trading session", () => {
  test("default config is always CONTINUOUS", () => {
    const clock = new ManualClock(at(3));
    const sim = createExchangeSimulator({
      clock: clock.now,
      config: { instruments: RIC },
    });
    expect(sim.marketPhase).toBe(TradingPhase.Continuous);
    expect(sim.getBook(RIC)?.phase).toBe(TradingPhase.Continuous);
    expect(sim.sessionStatus()).toEqual({
      phase: TradingPhase.Continuous,
      nextPhase: undefined,
      nextChangeAt: undefined,
      forced: false,
    });
  });

  test("phases follow the schedule and are published on prices.phase", () => {
    const { sim, runTo, phase, book } = sessionSim(at(7));
    expect(sim.marketPhase).toBe(TradingPhase.Closed);
    expect(phase()).toBe(TradingPhase.Closed);
    expect(phase("VOD.L")).toBe(TradingPhase.Closed);
    expect(sim.sessionStatus()).toMatchObject({
      phase: TradingPhase.Closed,
      nextPhase: TradingPhase.PreOpen,
      nextChangeAt: at(7, 30),
    });
    const events = book.events;
    runTo(at(7, 30));
    expect(phase()).toBe(TradingPhase.PreOpen);
    // bots idle in PRE_OPEN
    runTo(at(7, 31));
    expect(book.events).toBe(events);
    runTo(at(8));
    expect(phase()).toBe(TradingPhase.Continuous);
    runTo(at(8, 0) + 1_000);
    expect(book.events).toBeGreaterThan(events);
    expect(book.topOfBook().bid).toBeGreaterThan(0);
    runTo(at(16, 30), MIN);
    expect(phase()).toBe(TradingPhase.Closed);
    // bots pulled their quotes and stay idle
    expect(book.topOfBook()).toMatchObject({ bid: 0, ask: 0 });
    const closedEvents = book.events;
    runTo(at(16, 31));
    expect(book.events).toBe(closedEvents);
  });

  test("close expires DAY orders, keeps GTC; closed rejects new orders and amends", () => {
    const { sim, runTo, order, take, book, clock } = sessionSim(at(16), {
      mmRate: 0,
      takerRate: 0,
      mmPerInstrument: 0,
    });
    const gw = sim.gateway;
    const day = gw.submit(order({ price: 160 }));
    const gtc = gw.submit(
      order({ price: 159, timeInForce: TimeInForce.GoodTillCancel }),
    );
    take();
    runTo(at(16, 30));
    const reports = take();
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      exchangeOrderId: day,
      execType: ExecType.Expired,
      ordStatus: OrdStatus.Expired,
      leavesQty: 0,
      text: "DAY order expired at market close",
    });
    expect(book.book.order(day)).toBeUndefined();
    expect(book.book.order(gtc)).toBeDefined();
    expect(gw.getOrder(gtc)?.ordStatus).toBe(OrdStatus.New);

    gw.submit(order({ price: 161 }));
    expect(take()[0]).toMatchObject({
      execType: ExecType.Rejected,
      rejectReason: RejectReason.MarketClosed,
    });
    gw.amend(gtc, { price: 158 });
    expect(take()[0]).toMatchObject({
      execType: ExecType.Rejected,
      responseTo: "AMEND",
      rejectReason: RejectReason.MarketClosed,
    });
    // cancels are still accepted while closed
    gw.cancel(gtc);
    expect(take()[0]).toMatchObject({ execType: ExecType.Cancelled });
    expect(clock.time).toBe(at(16, 30));
  });

  test("PRE_OPEN accepts LIMIT DAY/GTC, rejects MARKET and IOC", () => {
    const { sim, take, order, book } = sessionSim(at(7, 45), {
      mmRate: 0,
      takerRate: 0,
    });
    const gw = sim.gateway;
    expect(book.phase).toBe(TradingPhase.PreOpen);
    gw.submit(order());
    gw.submit(order({ timeInForce: TimeInForce.GoodTillCancel }));
    expect(take().map((r) => r.execType)).toEqual([ExecType.New, ExecType.New]);
    gw.submit(order({ ordType: OrdType.Market, price: undefined }));
    expect(take()[0]).toMatchObject({
      execType: ExecType.Rejected,
      rejectReason: RejectReason.UnsupportedOrdType,
    });
    gw.submit(order({ timeInForce: TimeInForce.ImmediateOrCancel }));
    expect(take()[0]).toMatchObject({
      execType: ExecType.Rejected,
      rejectReason: RejectReason.UnsupportedTimeInForce,
    });
  });

  test("halted instruments stay halted through the session and resume to the market phase", () => {
    const { sim, runTo, order, take, phase } = sessionSim(at(15), {
      mmRate: 0,
      takerRate: 0,
    });
    const id = sim.gateway.submit(order());
    sim.haltInstrument(RIC, "news");
    take();
    runTo(at(16, 30));
    expect(phase()).toBe(TradingPhase.Halted);
    expect(phase("VOD.L")).toBe(TradingPhase.Closed);
    // DAY orders on halted books expire too
    expect(take()).toMatchObject([
      { exchangeOrderId: id, execType: ExecType.Expired },
    ]);
    sim.resumeInstrument(RIC);
    sim.flush();
    expect(phase()).toBe(TradingPhase.Closed);
  });

  test("setMarketPhase forces the phase until the next scheduled change", () => {
    const { sim, runTo, order, take, phase } = sessionSim(at(12), {
      mmRate: 0,
      takerRate: 0,
    });
    const id = sim.gateway.submit(order());
    take();
    expect(
      handleExchangeAdminRpc(sim, "setMarketPhase", { phase: "CLOSED" }),
    ).toEqual({
      type: "SUCCESS_RESULT",
      data: { rics: [RIC, "VOD.L"] },
    });
    expect(phase()).toBe(TradingPhase.Closed);
    expect(take()).toMatchObject([
      { exchangeOrderId: id, execType: ExecType.Expired },
    ]);
    expect(sim.sessionStatus()).toMatchObject({
      phase: TradingPhase.Closed,
      forced: true,
      nextChangeAt: at(16, 30),
    });
    runTo(at(13));
    expect(phase()).toBe(TradingPhase.Closed);
    handleExchangeAdminRpc(sim, "setMarketPhase", { phase: "CONTINUOUS" });
    expect(phase()).toBe(TradingPhase.Continuous);
    // the scheduled close takes over again
    runTo(at(16, 30));
    expect(phase()).toBe(TradingPhase.Closed);
    expect(sim.sessionStatus().forced).toBe(false);
    expect(
      handleExchangeAdminRpc(sim, "setMarketPhase", { phase: "HALTED" }),
    ).toMatchObject({ type: "ERROR_RESULT" });
  });

  test("setMarketPhase without a schedule lasts until changed", () => {
    const clock = new ManualClock(at(12));
    const sim = createExchangeSimulator({
      clock: clock.now,
      config: { instruments: RIC },
    });
    sim.setMarketPhase(TradingPhase.Closed);
    for (let i = 0; i < 100; i++) sim.step(clock.advance(HOUR));
    expect(sim.getBook(RIC)?.phase).toBe(TradingPhase.Closed);
    sim.setMarketPhase(TradingPhase.Continuous);
    expect(sim.getBook(RIC)?.phase).toBe(TradingPhase.Continuous);
  });

  test("fast simulated day cycles open and close", () => {
    const { runTo, phase, clock } = sessionSim(DAY0, {
      sessionOpen: "",
      sessionClose: "",
      preOpenMinutes: 0,
      sessionDayMs: 2_400,
    });
    expect(phase()).toBe(TradingPhase.Closed);
    runTo(clock.time + 900);
    expect(phase()).toBe(TradingPhase.Continuous);
    runTo(clock.time + 800);
    expect(phase()).toBe(TradingPhase.Closed);
    runTo(clock.time + 1_600);
    expect(phase()).toBe(TradingPhase.Continuous);
  });

  test("crossing orders in PRE_OPEN match immediately (no auction uncross)", () => {
    const { sim, runTo, order, take } = sessionSim(at(7, 45), {
      mmRate: 0,
      takerRate: 0,
    });
    const book = sim.getBook(RIC);
    sim.gateway.submit(order({ side: Side.Sell, price: 170 }));
    // crossing order matches immediately (no auction uncross)
    sim.gateway.submit(order({ price: 170, quantity: 40 }));
    expect(take().some((r) => r.execType === ExecType.Trade)).toBe(true);
    runTo(at(8));
    expect(book?.topOfBook()).toMatchObject({ ask: 170, askSize: 60 });
  });
});
