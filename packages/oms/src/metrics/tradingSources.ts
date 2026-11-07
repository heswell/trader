import type { ExchangeSimulator } from "@heswell/exchange-sim";
import type { MetricSource } from "@heswell/trading-metrics";
import {
  EXCHANGE_MODULE,
  isTerminalStatus,
  OMS_MODULE,
  TradingPhase,
} from "@heswell/trading-schemas";
import type { OmsService } from "../engine/OmsService";

/**
 * Exchange simulator, market data publisher and gateway metrics: counters
 * the simulator keeps anyway, plus its hot-path timers (sim.timers).
 */
export const exchangeMetricsSource = (sim: ExchangeSimulator): MetricSource => {
  // totals at the previous snapshot, for the interval's coalescing ratio
  let lastEvents = 0;
  let lastPrices = 0;
  return {
    name: "exchange",
    collect(w) {
      w.counter("exchange", "bookEvents", sim.bookEvents);
      w.counter("exchange", "trades", sim.tradeCount);
      w.counter("exchange", "deferredSteps", sim.deferredSteps);
      let volume = 0;
      let continuous = 0;
      for (const book of sim.books) {
        volume += book.stats.volume;
        if (book.phase === TradingPhase.Continuous) continuous++;
      }
      w.counter("exchange", "volume", volume, "shares");
      w.gauge("exchange", "books", sim.books.length);
      w.gauge("exchange", "continuousBooks", continuous);
      w.timers(sim.timers);

      const p = sim.publisher?.stats;
      if (!p) return;
      w.counter("publisher", "flushes", p.flushes);
      w.counter("publisher", "priceUpdates", p.priceUpdates);
      w.counter("publisher", "depthUpdates", p.depthUpdates);
      w.counter("publisher", "tradeInserts", p.tradeInserts);
      w.counter("publisher", "tradeEvictions", p.tradeEvictions);
      // Book events merged by the publish throttle over the interval:
      // 1 - prices rows written / book events (as perf:ws reports it).
      const events = sim.bookEvents - lastEvents;
      const prices = p.priceUpdates - lastPrices;
      lastEvents = sim.bookEvents;
      lastPrices = p.priceUpdates;
      w.gauge(
        "publisher",
        "coalescedPct",
        events > 0 ? Math.max(0, 100 * (1 - prices / events)) : 0,
        "%",
      );
      const tw = (table: string, total: number) =>
        w.tableWrites(EXCHANGE_MODULE, table, total);
      tw("prices", p.priceUpdates);
      tw("depth", p.depthUpdates);
      tw("trades", p.tradeInserts + p.tradeEvictions);
      tw("bars", p.barInserts + p.barUpdates + p.barEvictions);
      tw("bookSamples", p.sampleInserts + p.sampleEvictions);
      tw("bookOrders", p.bookOrderUpdates);
      tw("bookEvents", p.bookEventInserts + p.bookEventEvictions);
    },
  };
};

const total = (counts: ReadonlyMap<string, number>) => {
  let n = 0;
  for (const count of counts.values()) n += count;
  return n;
};

/** OMS order, position, reject, timer and table-write metrics. */
export const omsMetricsSource = (
  oms: Pick<OmsService, "engine"> & {
    tables: { writes: Readonly<Record<string, number>> };
  },
): MetricSource => ({
  name: "oms",
  collect(w) {
    const { engine } = oms;
    w.timers(engine.timers);
    const { stats, rejects, exchangeRejects } = engine;
    w.counter("oms", "duplicateReports", stats.duplicateReports);
    w.counter("oms", "unknownReports", stats.unknownReports);
    w.counter("oms", "stateErrorsIgnored", stats.stateErrorsIgnored);
    w.counter("oms", "rejects", total(rejects));
    for (const [reason, count] of rejects)
      w.counter("oms", `rejects.${reason}`, count);
    w.counter("oms", "exchangeRejects", total(exchangeRejects));
    for (const [reason, count] of exchangeRejects)
      w.counter("oms", `exchangeRejects.${reason}`, count);
    let live = 0;
    for (const parent of engine.parents.values()) {
      if (!isTerminalStatus(parent.state.status)) live++;
    }
    w.gauge("oms", "parentOrders", engine.parents.size);
    w.gauge("oms", "liveOrders", live);
    w.gauge("oms", "positions", engine.positions.size);
    w.gauge("oms", "runningAlgos", engine.runningAlgos.length);
    for (const [table, total] of Object.entries(oms.tables.writes)) {
      w.tableWrites(OMS_MODULE, table, total);
    }
  },
});
