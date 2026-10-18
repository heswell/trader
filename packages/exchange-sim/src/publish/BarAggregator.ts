import {
  barKey,
  bars as barsDef,
  parseBarInterval,
} from "@heswell/trading-schemas";
import { type PublishTable, RowLayout, round } from "./rows";

export interface BarOptions {
  /** Interval labels, e.g. ["1s", "1m", "5m"] (see parseBarInterval). */
  intervals: readonly string[];
  /** Closed bars kept per ric / interval (the current bar is extra). */
  history: number;
  /** Price decimals of an instrument (vwap is rounded to decimals + 2). */
  decimals: (ric: string) => number;
}

/** One OHLCV bar. Prices are trade prices (already on the tick grid). */
export interface Bar {
  readonly key: string;
  readonly ric: string;
  readonly interval: string;
  readonly start: number;
  readonly end: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  turnover: number;
  trades: number;
  closed: boolean;
  backfilled: boolean;
  /** Row written to the table. */
  inserted: boolean;
}

/** Data for a closed, synthetic bar (see barBackfill). */
export type BackfillBar = Pick<
  Bar,
  "start" | "open" | "high" | "low" | "close" | "volume" | "turnover" | "trades"
>;

interface Series {
  readonly ric: string;
  readonly interval: string;
  readonly intervalMs: number;
  /** Oldest first; the last one may be the current (open) bar. */
  readonly bars: Bar[];
}

export interface BarStats {
  barInserts: number;
  barUpdates: number;
  barEvictions: number;
}

export const alignStart = (time: number, intervalMs: number) =>
  Math.floor(time / intervalMs) * intervalMs;

/**
 * Builds OHLCV bars from the trade tape, per ric and interval, on the
 * exchange clock (trade timestamps). Trades are folded in as they happen;
 * `flush` (on the publisher cycle) closes bars whose interval has ended and
 * writes every changed bar once, so the current bar updates in place at the
 * publish rate. Intervals with no trades produce no bar (gaps are omitted).
 * Each series keeps `history` closed bars; older rows are deleted.
 */
export class BarAggregator {
  readonly intervals: readonly { label: string; ms: number }[];
  readonly #series = new Map<string, Series[]>();
  readonly #dirty = new Set<Bar>();
  readonly #layout: RowLayout<typeof barsDef>;

  constructor(
    readonly table: PublishTable,
    readonly options: BarOptions,
    readonly stats: BarStats,
  ) {
    this.intervals = options.intervals.map((label) => ({
      label,
      ms: parseBarInterval(label),
    }));
    this.#layout = new RowLayout(table, barsDef);
  }

  #seriesFor(ric: string) {
    let series = this.#series.get(ric);
    if (!series) {
      series = this.intervals.map(({ label, ms }) => ({
        ric,
        interval: label,
        intervalMs: ms,
        bars: [],
      }));
      this.#series.set(ric, series);
    }
    return series;
  }

  /** Bars of one ric / interval, oldest first (for tests and diagnostics). */
  barsOf(ric: string, interval: string): readonly Bar[] {
    return (
      this.#series.get(ric)?.find((s) => s.interval === interval)?.bars ?? []
    );
  }

  #push(series: Series, bar: Bar) {
    const { bars } = series;
    const last = bars.at(-1);
    if (last && !last.closed) {
      last.closed = true;
      this.#dirty.add(last);
    }
    bars.push(bar);
    this.#dirty.add(bar);
    this.#trim(series);
  }

  /** Keep `history` closed bars (plus the current one, while open). */
  #trim({ bars }: Series) {
    const open = bars.length > 0 && !(bars.at(-1) as Bar).closed;
    const max = this.options.history + (open ? 1 : 0);
    while (bars.length > max) {
      const evicted = bars.shift() as Bar;
      this.#dirty.delete(evicted);
      if (evicted.inserted) {
        this.table.delete(evicted.key);
        this.stats.barEvictions++;
      }
    }
  }

  addTrade(ric: string, price: number, size: number, timestamp: number) {
    for (const series of this.#seriesFor(ric)) {
      let bar = series.bars.at(-1);
      if (!bar || bar.closed || timestamp >= bar.end) {
        // A trade stamped before the end of an already closed bar (clock
        // skew between step and flush) opens the next interval instead.
        const time = bar ? Math.max(timestamp, bar.end) : timestamp;
        const start = alignStart(time, series.intervalMs);
        bar = {
          key: barKey(ric, series.interval, start),
          ric,
          interval: series.interval,
          start,
          end: start + series.intervalMs,
          open: price,
          high: price,
          low: price,
          close: price,
          volume: 0,
          turnover: 0,
          trades: 0,
          closed: false,
          backfilled: false,
          inserted: false,
        };
        this.#push(series, bar);
      } else {
        if (price > bar.high) bar.high = price;
        if (price < bar.low) bar.low = price;
        bar.close = price;
        this.#dirty.add(bar);
      }
      bar.volume += size;
      bar.turnover += price * size;
      bar.trades++;
    }
  }

  /**
   * Seed closed history for one ric / interval (oldest first). Call before
   * any trade of that ric; bars must end at or before the current interval.
   */
  backfill(ric: string, interval: string, history: readonly BackfillBar[]) {
    const series = this.#seriesFor(ric).find((s) => s.interval === interval);
    if (!series) throw Error(`bar interval ${interval} not configured`);
    for (const data of history) {
      this.#push(series, {
        ...data,
        key: barKey(ric, interval, data.start),
        ric,
        interval,
        end: data.start + series.intervalMs,
        closed: true,
        backfilled: true,
        inserted: false,
      });
    }
  }

  /** Close bars whose interval has ended, then write every changed bar. */
  flush(now: number) {
    for (const seriesList of this.#series.values()) {
      for (const series of seriesList) {
        const bar = series.bars.at(-1);
        if (bar && !bar.closed && now >= bar.end) {
          bar.closed = true;
          this.#dirty.add(bar);
          this.#trim(series);
        }
      }
    }
    if (this.#dirty.size === 0) return;
    for (const bar of this.#dirty) this.#write(bar);
    this.#dirty.clear();
  }

  #write(bar: Bar) {
    const { idx } = this.#layout;
    const row = this.#layout.row();
    row[idx.id] = bar.key;
    row[idx.ric] = bar.ric;
    row[idx.interval] = bar.interval;
    row[idx.start] = bar.start;
    row[idx.end] = bar.end;
    row[idx.open] = bar.open;
    row[idx.high] = bar.high;
    row[idx.low] = bar.low;
    row[idx.close] = bar.close;
    row[idx.volume] = bar.volume;
    row[idx.turnover] = round(bar.turnover, 2);
    row[idx.vwap] = bar.volume
      ? round(bar.turnover / bar.volume, this.options.decimals(bar.ric) + 2)
      : bar.close;
    row[idx.trades] = bar.trades;
    row[idx.closed] = bar.closed;
    row[idx.backfilled] = bar.backfilled;
    if (bar.inserted) {
      this.table.update(this.table.rowIndexAtKey(bar.key), row);
      this.stats.barUpdates++;
    } else {
      this.table.insert(row);
      bar.inserted = true;
      this.stats.barInserts++;
    }
  }
}
