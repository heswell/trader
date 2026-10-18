import {
  BOOK_SAMPLE_LEVELS,
  bookSampleKey,
  bookSamples as bookSamplesDef,
} from "@heswell/trading-schemas";
import { type PublishTable, RowLayout, type RowValue, round } from "./rows";

/** One published depth level (cum = cumulative size from the touch). */
export interface SampleLevel {
  readonly price: number;
  readonly size: number;
  readonly cum: number;
}

export interface BookSampleOptions {
  /** Sample interval (ms); sample times are aligned to multiples of it. */
  intervalMs: number;
  /** Samples kept per ric (oldest deleted). */
  history: number;
  /** Price decimals of an instrument (mid is rounded to decimals + 1). */
  decimals: (ric: string) => number;
}

export interface BookSampleStats {
  sampleInserts: number;
  sampleEvictions: number;
}

const LEVEL_COLUMNS = Array.from({ length: BOOK_SAMPLE_LEVELS }, (_, i) => ({
  bidPx: `bidPx${i}`,
  bidSz: `bidSz${i}`,
  askPx: `askPx${i}`,
  askSz: `askSz${i}`,
}));

/**
 * Periodic snapshots of each book's published top-N depth, for depth
 * heatmaps and spread / imbalance charts. Sampling reads the publisher's
 * last published levels (no extra book queries), so a sample reflects what
 * clients saw at that flush. Books with both sides empty are skipped.
 */
export class BookSampler {
  readonly #keys = new Map<string, string[]>();
  readonly #layout: RowLayout<typeof bookSamplesDef>;
  readonly #levelIdx: {
    bidPx: number;
    bidSz: number;
    askPx: number;
    askSz: number;
  }[];
  #nextAt = 0;

  constructor(
    readonly table: PublishTable,
    readonly options: BookSampleOptions,
    readonly stats: BookSampleStats,
  ) {
    this.#layout = new RowLayout(table, bookSamplesDef, null);
    const { columnMap } = table;
    this.#levelIdx = LEVEL_COLUMNS.map((names) => ({
      bidPx: columnMap[names.bidPx],
      bidSz: columnMap[names.bidSz],
      askPx: columnMap[names.askPx],
      askSz: columnMap[names.askSz],
    }));
  }

  /** True when a sample is due at `now` (advances the schedule). */
  due(now: number) {
    if (now < this.#nextAt) return false;
    const { intervalMs } = this.options;
    this.#nextAt = (Math.floor(now / intervalMs) + 1) * intervalMs;
    return true;
  }

  /** Sample time of a due sample: `now` aligned down to the interval. */
  sampleTime(now: number) {
    const { intervalMs } = this.options;
    return Math.floor(now / intervalMs) * intervalMs;
  }

  /** Samples kept for a ric, oldest first. */
  keysOf(ric: string): readonly string[] {
    return this.#keys.get(ric) ?? [];
  }

  sample(
    ric: string,
    time: number,
    bids: readonly SampleLevel[],
    asks: readonly SampleLevel[],
  ) {
    if (bids.length === 0 && asks.length === 0) return;
    const key = bookSampleKey(ric, time);
    let keys = this.#keys.get(ric);
    if (!keys) {
      keys = [];
      this.#keys.set(ric, keys);
    }
    if (keys.at(-1) === key) return;
    const { idx } = this.#layout;
    const row: RowValue[] = this.#layout.row();
    const bid = bids[0];
    const ask = asks[0];
    const bidDepth =
      bids[Math.min(bids.length, BOOK_SAMPLE_LEVELS) - 1]?.cum ?? 0;
    const askDepth =
      asks[Math.min(asks.length, BOOK_SAMPLE_LEVELS) - 1]?.cum ?? 0;
    row[idx.id] = key;
    row[idx.ric] = ric;
    row[idx.time] = time;
    row[idx.bid] = bid?.price ?? null;
    row[idx.ask] = ask?.price ?? null;
    row[idx.bidSize] = bid?.size ?? 0;
    row[idx.askSize] = ask?.size ?? 0;
    row[idx.bidDepth] = bidDepth;
    row[idx.askDepth] = askDepth;
    row[idx.imbalance] =
      bidDepth + askDepth > 0
        ? round((bidDepth - askDepth) / (bidDepth + askDepth), 4)
        : null;
    if (bid && ask) {
      const mid = (bid.price + ask.price) / 2;
      row[idx.mid] = round(mid, this.options.decimals(ric) + 1);
      row[idx.spreadBps] = round(((ask.price - bid.price) / mid) * 1e4, 2);
    }
    for (let i = 0; i < this.#levelIdx.length; i++) {
      const col = this.#levelIdx[i];
      const b = bids[i];
      const a = asks[i];
      row[col.bidPx] = b?.price ?? null;
      row[col.bidSz] = b?.size ?? 0;
      row[col.askPx] = a?.price ?? null;
      row[col.askSz] = a?.size ?? 0;
    }
    this.table.insert(row);
    this.stats.sampleInserts++;
    keys.push(key);
    if (keys.length > this.options.history) {
      this.table.delete(keys.shift() as string);
      this.stats.sampleEvictions++;
    }
  }
}
