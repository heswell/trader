import { bucketWidthFor } from "@heswell/trading-schemas";
import { lowerBound } from "./downsample";

export { bucketWidthFor };
import type { TimeSeries } from "./TimeSeries";

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
  /** Series instance and length per field when last computed. */
  readonly #seen = new Map<string, { series: TimeSeries; length: number }>();

  constructor(
    readonly fields: readonly string[],
    readonly series: (field: string) => TimeSeries,
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
        if (reset || oldFrom >= oldTo) bucketsIn(s, from, to, width, added);
        else {
          bucketsIn(s, from, Math.min(to, oldFrom), width, added);
          bucketsIn(s, Math.max(from, oldTo), to, width, added);
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
      this.#seen.set(field, { series: s, length: s.length });
    }
    return diff;
  }

  /** Recompute the buckets holding points appended since the last update. */
  #refreshTouched(diff: BucketDiff) {
    const width = this.#width;
    for (const field of this.fields) {
      const s = this.series(field);
      const seen = this.#seen.get(field);
      const since = seen ? seen.length : 0;
      if (s.length <= since) continue;
      const rows = this.#rows.get(field) as Map<number, BucketValue>;
      const from = Math.max(
        this.#from,
        Math.floor(s.times[since] / width) * width,
      );
      const fresh = bucketsIn(s, from, this.#to, width);
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
