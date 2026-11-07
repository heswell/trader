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
 * Exchange simulator and market data publisher metrics. Everything here
 * reads counters the simulator keeps anyway; nothing is added to its hot
 * paths.
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

/** OMS order, position and table-write metrics. */
export const omsMetricsSource = (oms: OmsService): MetricSource => ({
  name: "oms",
  collect(w) {
    const { engine } = oms;
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
