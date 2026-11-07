import { describe, expect, test } from "bun:test";
import type { ExecutionReport } from "@heswell/exchange-sim";
import {
  MetricsCollector,
  type MetricsSnapshot,
} from "@heswell/trading-metrics";
import {
  exchangeMetricsSource,
  omsMetricsSource,
} from "../src/metrics/tradingSources";
import { AAPL, BookSide, setup } from "./fixture";

const byId = (snapshot: MetricsSnapshot, id: string) =>
  snapshot.metrics.find((m) => m.id === id);

/** Collects the exchange + OMS sources of a fixture. */
const collect = (fixture: ReturnType<typeof setup>) => {
  const oms = { engine: fixture.engine, tables: { writes: {} } };
  const collector = new MetricsCollector({ process: false });
  collector.register(exchangeMetricsSource(fixture.sim));
  collector.register(omsMetricsSource(oms));
  collector.sample(0);
  return collector;
};

describe("hot-path timers", () => {
  test("order entry, risk, gateway, matching and reports are timed", () => {
    const fixture = setup();
    const { sim, engine, rest, create } = fixture;
    sim.timers.setMode("all");
    engine.timers.setMode("all");
    const collector = collect(fixture);

    rest(AAPL, BookSide.SELL, 170, 100);
    const id = create({ quantity: 100, price: 170 });
    expect(engine.getOrder(id)?.state.cumQty).toBe(100);
    sim.step();
    sim.flush();

    const snapshot = collector.sample(1_000);
    for (const timer of [
      "oms.createOrder",
      "oms.risk",
      "oms.executionReport",
      "oms.childAck",
      "oms.firstFill",
      "gateway.submit",
      "exchange.limit",
      "exchange.step",
      "publisher.flush",
    ]) {
      const row = byId(snapshot, timer);
      expect(row?.kind, timer).toBe("timer");
      expect(row?.value, timer).toBeGreaterThan(0);
      expect(row?.rate, timer).toBeGreaterThan(0);
    }
    // ack and fill, at least: one timed call per report
    expect(byId(snapshot, "oms.executionReport")?.value).toBeGreaterThanOrEqual(
      2,
    );
  });

  test("lifecycle latencies come from the order timestamps", () => {
    const fixture = setup({ latencyMs: 5 });
    const { engine, rest, create, scheduler, clock } = fixture;
    engine.timers.setMode("all");
    const collector = collect(fixture);
    rest(AAPL, BookSide.SELL, 170, 100);
    create({ quantity: 100, price: 170 });
    for (let i = 0; i < 2; i++) {
      clock.advance(5);
      scheduler.advance(5);
    }

    const snapshot = collector.sample(1_000);
    // request out (5 ms) + report back (5 ms)
    expect(byId(snapshot, "oms.childAck")?.max).toBe(10_000);
    expect(byId(snapshot, "oms.firstFill")?.max).toBe(10_000);
  });

  test("off: calls are counted, nothing is timed", () => {
    const fixture = setup();
    const collector = collect(fixture);
    fixture.create();
    const row = byId(collector.sample(1_000), "oms.createOrder");
    expect(row).toMatchObject({ value: 0, rate: 1 });
  });
});

describe("OMS counters", () => {
  test("rejects by reason", () => {
    const fixture = setup();
    const { engine, order, ctx } = fixture;
    const collector = collect(fixture);
    const result = engine.createOrder(order({ ric: "NOPE.X" }), ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const unknown = engine.cancelOrder({ orderId: "O-404" }, ctx);
    expect(unknown.ok).toBe(false);

    const snapshot = collector.sample(1_000);
    expect(byId(snapshot, "oms.rejects")?.value).toBe(2);
    expect(byId(snapshot, `oms.rejects.${result.reason}`)?.value).toBe(1);
  });

  test("duplicate and unknown execution reports are counted", () => {
    const fixture = setup();
    const { engine, sim, create } = fixture;
    const reports: ExecutionReport[] = [];
    sim.gateway.onExecutionReport((r) => reports.push(r));
    create();
    expect(reports.length).toBeGreaterThan(0);
    engine.applyExecutionReport(reports[0]);
    engine.applyExecutionReport({
      ...reports[0],
      exchangeOrderId: "X-none",
      clOrdId: "none",
    });
    expect(engine.stats).toMatchObject({
      duplicateReports: 1,
      unknownReports: 1,
    });
  });
});
