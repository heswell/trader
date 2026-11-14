import { bucketWidthFor } from "@heswell/trading-schemas";
import { lowerBound } from "./downsample";
import type { HistoryTree } from "./HistoryTree";
import type { TimeSeries } from "./TimeSeries";

export { bucketWidthFor };

/** M4 of one time bucket: count and the first / min / max / last point. */
export interface BucketValue {
  bucket: number;
  count: number;
  firstT: number;
  first: number;
  minT: number;
  min: number;
  maxT: number;
  max: number;
  lastT: number;
  last: number;
}

const MM: [number, number] = [0, 0];

/** M4 of `[lo, hi)` (non-empty) as the bucket starting at `bucket`. */
const m4Of = (
  s: TimeSeries,
  bucket: number,
  lo: number,
  hi: number,
): BucketValue => {
  const { times, values } = s;
  const [mn, mx] = s.minMax(lo, hi, MM);
  return {
    bucket,
    count: hi - lo,
    firstT: times[lo],
    first: values[lo],
    minT: times[mn],
    min: values[mn],
    maxT: times[mx],
    max: values[mx],
    lastT: times[hi - 1],
    last: values[hi - 1],
  };
};

/** Every non-empty bucket of `width` in `[from, to)` (from / to aligned). */
export const bucketsIn = (
  s: TimeSeries,
  from: number,
  to: number,
  width: number,
  out: BucketValue[] = [],
) => {
  const { times, length } = s;
  let lo = lowerBound(times, from, 0, length);
  while (lo < length && times[lo] < to) {
    const bucket = Math.floor(times[lo] / width) * width;
    const hi = lowerBound(times, bucket + width, lo, length);
    out.push(m4Of(s, bucket, lo, hi));
    lo = hi;
  }
  return out;
};

/**
 * One field's data as a BucketWindow sees it: generated history in a
 * HistoryTree (optional, older), then stored points (generated tail and live
 * samples) in a TimeSeries, which is where new points are appended. A new
 * source object is made whenever either part is replaced.
 */
export class SeriesSource {
  constructor(
    readonly stored: TimeSeries,
    readonly tree?: HistoryTree,
    /** Tree values to output values (the tree works in log space). */
    readonly toValue: (x: number) => number = Math.exp,
  ) {}

  /** Time of the first point, if any. */
  get first() {
    return this.tree ? this.tree.start : this.stored.first;
  }
  /** Time of the last point, if any. */
  get last() {
    return (
      this.stored.last ??
      (this.tree ? this.tree.end - this.tree.baseMs : undefined)
    );
  }
  /** Points, tree included. */
  get length() {
    return this.stored.length + (this.tree?.length ?? 0);
  }

  /** M4 of every non-empty bucket of `width` in `[from, to)` (aligned). */
  bucketsIn(from: number, to: number, width: number, out: BucketValue[] = []) {
    const { tree } = this;
    if (!tree) return bucketsIn(this.stored, from, to, width, out);
    tree.bucketsIn(from, to, width, this.toValue, out);
    if (to <= tree.end) return out;
    const split = out.length;
    bucketsIn(this.stored, Math.max(from, tree.end), to, width, out);
    // a bucket wider than the tree's top level can straddle its end
    if (split > 0 && split < out.length) {
      const a = out[split - 1];
      const b = out[split];
      if (a.bucket === b.bucket) {
        a.count += b.count;
        if (b.min < a.min) {
          a.min = b.min;
          a.minT = b.minT;
        }
        if (b.max > a.max) {
          a.max = b.max;
          a.maxT = b.maxT;
        }
        a.last = b.last;
        a.lastT = b.lastT;
        out.splice(split, 1);
      }
    }
    return out;
  }
}

const sameValue = (a: BucketValue, b: BucketValue) =>
  a.count === b.count &&
  a.lastT === b.lastT &&
  a.minT === b.minT &&
  a.maxT === b.maxT &&
  a.firstT === b.firstT;

export interface WindowSpec {
  start: number;
  end: number;
  /** Columns the window is drawn with: about one bucket per point. */
  points: number;
  /** Slide with the live edge: the window is the last `end - start` up to now. */
  follow?: boolean;
}

/** Changes to send: bucket rows to remove, and rows to insert or update. */
export interface BucketDiff {
  width: number;
  /** The width changed: everything was removed and resent. */
  reset: boolean;
  removed: { field: string; bucket: number }[];
  upserts: { field: string; value: BucketValue }[];
}

/**
 * One subscriber's view of a series as M4 buckets on the clock-aligned grid,
 * like a viewport over rows keyed by bucket start. setWindow returns what to
 * remove and add (a pan sends only the buckets entering the window; a change
 * of width level resends all); tick returns the buckets new points changed
 * (in follow mode also the slide).
 */
export class BucketWindow {
  #spec: WindowSpec | undefined;
  #width = 0;
  #from = 0;
  #to = 0;
  readonly #rows = new Map<string, Map<number, BucketValue>>();
  /** Source instance and stored length per field when last computed. */
  readonly #seen = new Map<string, { series: SeriesSource; length: number }>();

  constructor(
    readonly fields: readonly string[],
    readonly series: (field: string) => SeriesSource,
    readonly baseMs: number,
  ) {
    for (const f of fields) this.#rows.set(f, new Map());
  }

  get width() {
    return this.#width;
  }
  get range() {
    return { from: this.#from, to: this.#to };
  }
  get spec() {
    return this.#spec;
  }
  /** Buckets held, all fields. */
  get size() {
    let n = 0;
    for (const rows of this.#rows.values()) n += rows.size;
    return n;
  }

  #bounds(spec: WindowSpec, now: number) {
    const span = Math.max(1, spec.end - spec.start);
    const width = bucketWidthFor(span, spec.points, this.baseMs);
    const end = spec.follow ? now : spec.end;
    const start = end - span;
    const from = Math.floor(start / width) * width;
    const to = (Math.floor((end - 1) / width) + 1) * width;
    return { width, from, to };
  }

  setWindow(spec: WindowSpec, now: number): BucketDiff {
    this.#spec = spec;
    return this.#update(now, false);
  }

  /** New points arrived (and the live edge moved to `now`). */
  tick(now: number): BucketDiff {
    if (!this.#spec)
      return { width: 0, reset: false, removed: [], upserts: [] };
    return this.#update(now, true);
  }

  #update(now: number, ticked: boolean): BucketDiff {
    const spec = this.#spec as WindowSpec;
    const { width, from, to } = this.#bounds(spec, now);
    const diff: BucketDiff = { width, reset: false, removed: [], upserts: [] };
    // A new width level, or a series swapped (history generated / dropped).
    const swapped = this.fields.some(
      (f) => this.#seen.get(f)?.series !== this.series(f),
    );
    const reset = width !== this.#width || swapped;
    if (!ticked || reset || this.#from !== from || this.#to !== to) {
      const oldFrom = reset ? to : this.#from;
      const oldTo = reset ? to : this.#to;
      diff.reset = reset && this.#width !== 0;
      for (const field of this.fields) {
        const rows = this.#rows.get(field) as Map<number, BucketValue>;
        for (const bucket of rows.keys()) {
          if (reset || bucket < from || bucket >= to) {
            rows.delete(bucket);
            diff.removed.push({ field, bucket });
          }
        }
        const s = this.series(field);
        const added: BucketValue[] = [];
        if (reset || oldFrom >= oldTo) s.bucketsIn(from, to, width, added);
        else {
          s.bucketsIn(from, Math.min(to, oldFrom), width, added);
          s.bucketsIn(Math.max(from, oldTo), to, width, added);
        }
        for (const value of added) {
          rows.set(value.bucket, value);
          diff.upserts.push({ field, value });
        }
      }
      this.#width = width;
      this.#from = from;
      this.#to = to;
    }
    if (ticked && !reset) this.#refreshTouched(diff);
    for (const field of this.fields) {
      const s = this.series(field);
      this.#seen.set(field, { series: s, length: s.stored.length });
    }
    return diff;
  }

  /** Recompute the buckets holding points appended since the last update. */
  #refreshTouched(diff: BucketDiff) {
    const width = this.#width;
    for (const field of this.fields) {
      const s = this.series(field).stored;
      const seen = this.#seen.get(field);
      const since = seen ? seen.length : 0;
      if (s.length <= since) continue;
      const rows = this.#rows.get(field) as Map<number, BucketValue>;
      const from = Math.max(
        this.#from,
        Math.floor(s.times[since] / width) * width,
      );
      const fresh = this.series(field).bucketsIn(from, this.#to, width);
      for (const value of fresh) {
        const held = rows.get(value.bucket);
        if (held && sameValue(held, value)) continue;
        rows.set(value.bucket, value);
        // a bucket also added by the slide above: replace that upsert
        const i = diff.upserts.findIndex(
          (u) => u.field === field && u.value.bucket === value.bucket,
        );
        if (i >= 0) diff.upserts[i] = { field, value };
        else diff.upserts.push({ field, value });
      }
    }
  }
}
