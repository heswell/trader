import { describe, expect, test } from "bun:test";
import { Side as BookSide } from "@heswell/hft-limit-order-book";
import {
  OrdStatus,
  OrdType,
  Side,
  TimeInForce,
} from "@heswell/trading-schemas";
import {
  createExchangeSimulator,
  type ExchangeSimulator,
} from "../src/engine/ExchangeSimulator";
import type {
  ExchangeJournalEntry,
  ExchangeState,
} from "../src/engine/persistence";
import { TRADE_ID_BLOCK } from "../src/engine/persistence";
import type { GatewayNewOrder } from "../src/gateway/types";
import { ManualClock } from "../src/util/clock";

const RIC = "AAPL.OQ";

const make = () => {
  const clock = new ManualClock();
  const sim = createExchangeSimulator({
    clock: clock.now,
    config: { instruments: `${RIC},VOD.L`, mmRate: 0, takerRate: 0 },
  });
  const journal: ExchangeJournalEntry[] = [];
  sim.setJournal((e) => journal.push(structuredClone(e)));
  return { clock, sim, journal };
};

let cl = 0;
const order = (o: Partial<GatewayNewOrder> = {}): GatewayNewOrder => ({
  account: "ACC1",
  clOrdId: `c${++cl}`,
  ric: RIC,
  side: Side.Buy,
  ordType: OrdType.Limit,
  quantity: 100,
  price: 170,
  timeInForce: TimeInForce.Day,
  ...o,
});

const bids = (sim: ExchangeSimulator) =>
  (sim.getBook(RIC)?.book.snapshot().bids ?? []).flatMap((level) =>
    level.orders.map((o) => `${o.id} ${o.size}@${o.price}`),
  );

describe("exchange persistence", () => {
  test("snapshot restore keeps time priority, quantities and counters", () => {
    const a = make();
    const first = a.sim.gateway.submit(order());
    const second = a.sim.gateway.submit(order());
    a.sim
      .getBook(RIC)
      ?.limit({ id: "bot", side: BookSide.SELL, price: 170, size: 30 });
    const state = structuredClone(a.sim.exportState()) as ExchangeState;

    const b = make();
    const result = b.sim.restoreState(state, []);
    expect(result.restoredOrders).toBe(2);
    expect(bids(b.sim)).toEqual(bids(a.sim));
    expect(bids(b.sim)).toEqual([`${first} 70@170`, `${second} 100@170`]);
    expect(b.sim.gateway.getOrder(first)?.cumQty).toBe(30);
    // New ids continue after the restored ones.
    const third = b.sim.gateway.submit(order({ price: 169 }));
    expect([first, second]).not.toContain(third);
    expect(b.sim.tradeCount).toBe(a.sim.tradeCount);
  });

  test("journal replay re-queues amended orders and reserves trade ids", () => {
    const a = make();
    const state = structuredClone(a.sim.exportState()) as ExchangeState;
    const first = a.sim.gateway.submit(order());
    const second = a.sim.gateway.submit(order());
    // A price-improving amend loses priority.
    a.sim.gateway.amend(first, { price: 170, quantity: 120 });
    a.sim
      .getBook(RIC)
      ?.limit({ id: "bot", side: BookSide.SELL, price: 170, size: 10 });
    expect(a.journal.some((e) => e.k === "tradeSeq")).toBe(true);

    const b = make();
    b.sim.restoreState(state, a.journal);
    expect(bids(b.sim)).toEqual(bids(a.sim));
    expect(bids(b.sim)[0].startsWith(second)).toBe(true);
    // After a crash the trade id resumes past the reserved block.
    expect(b.sim.tradeCount).toBe(TRADE_ID_BLOCK);
    expect(b.sim.gateway.getOrder(second)?.ordStatus).toBe(
      OrdStatus.PartiallyFilled,
    );
  });

  test("a restart after the close expires DAY orders, keeps GTC", () => {
    const config = {
      instruments: RIC,
      mmRate: 0,
      takerRate: 0,
      sessionDayMs: 24_000,
    };
    const clock = new ManualClock();
    const a = createExchangeSimulator({ clock: clock.now, config });
    while (a.marketPhase !== "CONTINUOUS") a.updateSession(clock.advance(100));
    const day = a.gateway.submit(order());
    const gtc = a.gateway.submit(
      order({ timeInForce: TimeInForce.GoodTillCancel }),
    );
    const state = structuredClone(a.exportState()) as ExchangeState;
    const since = clock.time;

    clock.advance(24_000);
    const b = createExchangeSimulator({ clock: clock.now, config });
    b.restoreState(state, []);
    expect(b.catchUpSession(since)).toEqual([day]);
    expect(b.gateway.getOrder(day)?.ordStatus).toBe(OrdStatus.Expired);
    expect(b.gateway.getOrder(gtc)?.ordStatus).toBe(OrdStatus.New);
  });
});
