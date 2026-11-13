import {
  type DownsampleMethod,
  RejectReason,
  TIME_SERIES_FIELDS,
  type TimeSeriesData,
  type TimeSeriesField,
  type TimeSeriesRequest,
  type TimeSeriesResponse,
} from "@heswell/trading-schemas";
import { Random } from "../util/random";
import {
  lowerBound,
  lttbIndices,
  m4Indices,
  minMaxIndices,
  rangeIndices,
  withGaps,
} from "./downsample";
import { generateHistory } from "./historyGen";
import { TimeSeries } from "./TimeSeries";

/** What the store needs to know about an instrument to generate history. */
export interface HistorySource {
  /** Current fair value / mid. */
  mid: number;
  volatility: number;
  tick: number;
  /** Price decimals (mids are rounded to decimals + 1 in responses). */
  decimals: number;
  /** Typical spread (bps), the spread history's level. */
  spreadBps: number;
}

/** A live sample of one instrument (both sides quoted). */
export interface TouchSample {
  ric: string;
  bid: number;
  ask: number;
}

export interface TimeSeriesStoreOptions {
  /** Interval between points (ms); 0 disables sampling. */
  intervalMs: number;
  /** Synthetic history generated in front of the live points (ms). */
  historyMs: number;
  /** Instruments that hold generated history at once (least recently queried dropped). */
  maxHistoryRics: number;
  timeScale: number;
  seed: number;
  /** Instrument details for history, undefined for an unknown ric. */
  source: (ric: string) => HistorySource | undefined;
}

export class TimeSeriesError extends Error {
  constructor(
    readonly reason: RejectReason,
    message: string,
  ) {
    super(message);
  }
}

interface Entry {
  series: Record<TimeSeriesField, TimeSeries>;
  /** Generated points in front of the live ones (0 = live only). */
  historyPoints: number;
  lastQueried: number;
  decimals: number;
}

const FIELD_DECIMALS: Record<TimeSeriesField, (d: number) => number> = {
  mid: (d) => d + 1,
  spreadBps: () => 2,
};

/** Candidates per output point for MinMaxLTTB's preselection. */
const MINMAX_LTTB_RATIO = 4;

const round = (v: number, decimals: number) => {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
};

/**
 * Per-instrument time series for large-history charts: mid and spread at
 * `intervalMs`, sampled live from every book, with `historyMs` of synthetic
 * history generated on the first query of an instrument (for at most
 * `maxHistoryRics` at once). `query` answers the timeSeries RPC.
 */
export class TimeSeriesStore {
  readonly #entries = new Map<string, Entry>();
  #nextAt = 0;
  #queries = 0;

  constructor(readonly options: TimeSeriesStoreOptions) {}

  get gapMs() {
    return this.options.intervalMs * 3;
  }

  #entry(ric: string): Entry {
    let entry = this.#entries.get(ric);
    if (!entry) {
      const source = this.options.source(ric);
      if (!source)
        throw new TimeSeriesError(
          RejectReason.UnknownInstrument,
          `no time series for ${ric}`,
        );
      entry = {
        series: {
          mid: new TimeSeries(this.gapMs, 256),
          spreadBps: new TimeSeries(this.gapMs, 256),
        },
        historyPoints: 0,
        lastQueried: 0,
        decimals: source.decimals,
      };
      this.#entries.set(ric, entry);
    }
    return entry;
  }

  /** True when a sample is due at `now` (advances the schedule). */
  due(now: number) {
    const { intervalMs } = this.options;
    if (!(intervalMs > 0) || now < this.#nextAt) return false;
    this.#nextAt = (Math.floor(now / intervalMs) + 1) * intervalMs;
    return true;
  }

  /** Append one point per two-sided book at `now` aligned to the interval. */
  sample(now: number, touches: Iterable<TouchSample>) {
    const { intervalMs } = this.options;
    const time = Math.floor(now / intervalMs) * intervalMs;
    for (const { ric, bid, ask } of touches) {
      if (!(bid > 0 && ask > 0 && ask >= bid)) continue;
      let entry: Entry;
      try {
        entry = this.#entry(ric);
      } catch {
        continue;
      }
      const mid = (bid + ask) / 2;
      entry.series.mid.append(time, mid);
      entry.series.spreadBps.append(time, ((ask - bid) / mid) * 1e4);
    }
  }

  /** Generate history for `ric` if it has none (evicting the LRU one). */
  #ensureHistory(ric: string, entry: Entry, now: number) {
    entry.lastQueried = ++this.#queries;
    if (entry.historyPoints > 0) return;
    const { intervalMs, historyMs, maxHistoryRics, timeScale, seed } =
      this.options;
    const count = Math.floor(historyMs / intervalMs);
    if (count <= 0) return;
    const withHistory = [...this.#entries.entries()].filter(
      ([, e]) => e.historyPoints > 0,
    );
    if (withHistory.length >= maxHistoryRics) {
      withHistory.sort(([, a], [, b]) => a.lastQueried - b.lastQueried);
      for (const [, e] of withHistory.slice(
        0,
        withHistory.length - maxHistoryRics + 1,
      ))
        this.#dropHistory(e);
    }
    const source = this.options.source(ric) as HistorySource;
    const mid = entry.series.mid;
    const spread = entry.series.spreadBps;
    const end = mid.length
      ? (mid.first as number)
      : Math.floor(now / intervalMs) * intervalMs;
    let hash = seed >>> 0;
    for (let i = 0; i < ric.length; i++)
      hash = Math.imul(hash ^ ric.charCodeAt(i), 0x01000193) >>> 0;
    const gen = generateHistory({
      count,
      intervalMs,
      end,
      mid: mid.length ? mid.values[0] : source.mid,
      volatility: source.volatility,
      timeScale,
      tick: source.tick,
      spreadBps: spread.length ? spread.values[0] : source.spreadBps,
      rng: new Random(hash),
    });
    entry.series = {
      mid: mid.prepend(gen.times, gen.mid),
      spreadBps: spread.prepend(gen.times, gen.spreadBps),
    };
    entry.historyPoints = count;
  }

  #dropHistory(entry: Entry) {
    const n = entry.historyPoints;
    const drop = (s: TimeSeries) => {
      const live = TimeSeries.from(
        s.times.slice(n, Math.max(n, s.length)),
        s.values.slice(n, Math.max(n, s.length)),
        s.gapMs,
      );
      return live.length ? live : new TimeSeries(s.gapMs, 256);
    };
    entry.series = {
      mid: drop(entry.series.mid),
      spreadBps: drop(entry.series.spreadBps),
    };
    entry.historyPoints = 0;
  }

  /** The series of a ric and field (generating history), for tests and benches. */
  series(ric: string, field: TimeSeriesField, now: number) {
    const entry = this.#entry(ric);
    this.#ensureHistory(ric, entry, now);
    return entry.series[field];
  }

  /** Instruments, points and bytes held. */
  stats() {
    let points = 0;
    let bytes = 0;
    let withHistory = 0;
    for (const entry of this.#entries.values()) {
      if (entry.historyPoints) withHistory++;
      for (const s of Object.values(entry.series)) {
        points += s.length;
        bytes += s.bytes;
      }
    }
    return { rics: this.#entries.size, withHistory, points, bytes };
  }

  /** Answer a (validated) timeSeries request at server time `now`. */
  query(req: TimeSeriesRequest, now: number): TimeSeriesResponse {
    const t0 = performance.now();
    const end = req.end ?? now;
    const start = req.start ?? end - 3_600_000;
    if (!(end > start))
      throw new TimeSeriesError(
        RejectReason.InvalidRequest,
        "end must be after start",
      );
    const fields = (req.fields ?? "mid")
      .split(",")
      .map((f) => f.trim())
      .filter(Boolean);
    for (const f of fields)
      if (!(TIME_SERIES_FIELDS as readonly string[]).includes(f))
        throw new TimeSeriesError(
          RejectReason.InvalidRequest,
          `unknown field ${f} (one of ${TIME_SERIES_FIELDS.join(", ")})`,
        );
    const entry = this.#entry(req.ric);
    this.#ensureHistory(req.ric, entry, now);
    const method: DownsampleMethod = req.method ?? "m4";
    const points = req.points;
    const span = end - start;
    // M4 keeps up to 4 points per bucket; MinMaxLTTB preselects 2 per bucket.
    const minBucket =
      method === "minmaxlttb"
        ? span / ((points * MINMAX_LTTB_RATIO) / 2)
        : span / Math.max(1, Math.floor(points / 4));
    const bucketMs = Math.max(
      1,
      Math.ceil(Math.max(req.bucketMs ?? 0, minBucket)),
    );
    const series: TimeSeriesData[] = [];
    let first = 0;
    let last = 0;
    for (const field of fields as TimeSeriesField[]) {
      const s = entry.series[field];
      if (s.length) {
        first = s.first as number;
        last = s.last as number;
      }
      const lo = lowerBound(s.times, start, 0, s.length);
      const hi = lowerBound(s.times, end, lo, s.length);
      let selected: number[];
      if (hi <= lo) selected = [];
      else if (method === "m4")
        selected = m4Indices(s, start, end, bucketMs, s.minMax);
      else if (method === "minmaxlttb") {
        const candidates = minMaxIndices(s, start, end, bucketMs, s.minMax);
        if (candidates[0] !== lo) candidates.unshift(lo);
        if (candidates[candidates.length - 1] !== hi - 1)
          candidates.push(hi - 1);
        selected = lttbIndices(s, candidates, points);
      } else if (method === "lttb")
        selected = lttbIndices(s, rangeIndices(lo, hi), points);
      else {
        const stride = Math.ceil((hi - lo) / points);
        selected = [];
        for (let i = lo; i < hi; i += stride) selected.push(i);
      }
      // One point either side so the line runs to the window's edges.
      if (selected.length) {
        if (selected[0] > 0) selected.unshift(selected[0] - 1);
        const tail = selected[selected.length - 1];
        if (tail + 1 < s.length) selected.push(tail + 1);
      }
      series.push({
        ...encode(s, selected, FIELD_DECIMALS[field](entry.decimals)),
        field,
        sourcePoints: hi - lo,
      });
    }
    return {
      ric: req.ric,
      start,
      end,
      method,
      bucketMs,
      first,
      last,
      now,
      intervalMs: this.options.intervalMs,
      series,
      serverMs: round(performance.now() - t0, 3),
    };
  }
}

/** Delta-encode the selected points, with a null at each gap. */
const encode = (
  s: TimeSeries,
  selected: number[],
  decimals: number,
): Pick<TimeSeriesData, "t0" | "t" | "v"> => {
  const { indices, breaks } = withGaps(selected, s.gaps);
  const t0 = indices.length ? s.times[indices[0]] : 0;
  const t: number[] = [];
  const v: (number | null)[] = [];
  let prev = t0;
  for (let p = 0; p < indices.length; p++) {
    const time = s.times[indices[p]];
    if (breaks.has(p)) {
      const mid = Math.round((prev + time) / 2);
      t.push(mid - prev);
      v.push(null);
      prev = mid;
    }
    t.push(time - prev);
    v.push(round(s.values[indices[p]], decimals));
    prev = time;
  }
  return { t0, t, v };
};
