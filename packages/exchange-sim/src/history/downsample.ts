/**
 * Downsampling for large time series: choose at most about `points` samples
 * from `[start, end)` so a line drawn through them looks like the line drawn
 * through every point.
 *
 * - M4 (Jugel et al., VLDB 2014): split the window into time buckets (one per
 *   pixel column) and keep the first, last, min and max point of each. A line
 *   through those is pixel-identical to the full line at that width, for any
 *   data. With a min/max pyramid the cost per bucket is about constant, so a
 *   request costs the same for an hour or a week.
 * - LTTB (Steinarsson 2013): split by index into `points` buckets and keep
 *   the point forming the largest triangle with its neighbours. Fewer points
 *   for a similar look, but O(n) in the window and it can drop single spikes.
 * - MinMaxLTTB (Van Der Donckt et al. 2023): preselect min/max per time
 *   bucket from the pyramid (`ratio` × points candidates), then LTTB over the
 *   candidates. LTTB's look at M4's cost.
 *
 * All functions work on index ranges of typed arrays and return selected
 * indices (ascending), so callers can read any column at those indices.
 */

/** A time-ordered series view: `times[0..length)` ascending, ms. */
export interface SeriesArrays {
  readonly times: Float64Array;
  readonly values: Float64Array;
  readonly length: number;
}

/** First index in `[lo, hi)` with `times[i] >= t` (hi if none). */
export const lowerBound = (
  times: Float64Array,
  t: number,
  lo: number,
  hi: number,
) => {
  let a = lo;
  let b = hi;
  while (a < b) {
    const m = (a + b) >>> 1;
    if (times[m] < t) a = m + 1;
    else b = m;
  }
  return a;
};

/** log2 of the pyramid's finest block size (32 points). */
export const PYRAMID_BASE_LOG2 = 5;

/**
 * Min/max index pyramid over a growable value array. Level k holds, for each
 * block of `32 << k` points, the index of its min and its max value. A range
 * query covers the range with the largest aligned complete blocks (at most
 * two per level) plus fewer than 32 raw points at each end, so it costs
 * O(32 + log n) whatever the range width. Memory: 8 bytes per 32 points at
 * level 0, about 0.5 bytes per point in all.
 */
export class MinMaxPyramid {
  #minIdx: Uint32Array[] = [];
  #maxIdx: Uint32Array[] = [];
  #capacity = 0;

  constructor(
    private values: Float64Array,
    capacity = values.length,
  ) {
    this.#resize(capacity);
  }

  /** Levels currently held. */
  get levels() {
    return this.#minIdx.length;
  }

  /** Bytes held by the index arrays. */
  get bytes() {
    let n = 0;
    for (const a of this.#minIdx) n += a.byteLength * 2;
    return n;
  }

  #resize(capacity: number) {
    const levels: number[] = [];
    for (let k = 0; 1 << (PYRAMID_BASE_LOG2 + k) <= capacity; k++)
      levels.push(Math.ceil(capacity / (1 << (PYRAMID_BASE_LOG2 + k))));
    const minIdx = levels.map((n) => new Uint32Array(n));
    const maxIdx = levels.map((n) => new Uint32Array(n));
    for (let k = 0; k < Math.min(levels.length, this.#minIdx.length); k++) {
      minIdx[k].set(this.#minIdx[k].subarray(0, minIdx[k].length));
      maxIdx[k].set(this.#maxIdx[k].subarray(0, maxIdx[k].length));
    }
    this.#minIdx = minIdx;
    this.#maxIdx = maxIdx;
    this.#capacity = capacity;
  }

  /** The value array was reallocated (grown): keep blocks, add levels. */
  grow(values: Float64Array, length: number) {
    const oldLevels = this.levels;
    this.values = values;
    this.#resize(values.length);
    if (oldLevels === 0) this.build(length);
    // New levels: build from the level below.
    else
      for (let k = oldLevels; k < this.levels; k++) this.#buildLevel(k, length);
  }

  /** Build every level from `values[0..length)`. */
  build(length: number) {
    if (this.levels === 0) return;
    const { values } = this;
    const min0 = this.#minIdx[0];
    const max0 = this.#maxIdx[0];
    const size = 1 << PYRAMID_BASE_LOG2;
    for (let j = 0, lo = 0; lo < length; j++, lo += size) {
      const hi = Math.min(length, lo + size);
      let mn = lo;
      let mx = lo;
      for (let i = lo + 1; i < hi; i++) {
        const v = values[i];
        if (v < values[mn]) mn = i;
        if (v > values[mx]) mx = i;
      }
      min0[j] = mn;
      max0[j] = mx;
    }
    for (let k = 1; k < this.levels; k++) this.#buildLevel(k, length);
  }

  #buildLevel(k: number, length: number) {
    const { values } = this;
    const cMin = this.#minIdx[k - 1];
    const cMax = this.#maxIdx[k - 1];
    const min = this.#minIdx[k];
    const max = this.#maxIdx[k];
    const children = Math.ceil(length / (1 << (PYRAMID_BASE_LOG2 + k - 1)));
    for (let j = 0; 2 * j < children; j++) {
      const a = 2 * j;
      const b = a + 1;
      if (b < children) {
        min[j] = values[cMin[b]] < values[cMin[a]] ? cMin[b] : cMin[a];
        max[j] = values[cMax[b]] > values[cMax[a]] ? cMax[b] : cMax[a];
      } else {
        min[j] = cMin[a];
        max[j] = cMax[a];
      }
    }
  }

  /** Point `i` was appended (values[i] set, i = previous length). */
  append(i: number) {
    if (i >= this.#capacity) throw Error("MinMaxPyramid: grow() first");
    const v = this.values[i];
    for (let k = 0; k < this.levels; k++) {
      const shift = PYRAMID_BASE_LOG2 + k;
      const j = i >>> shift;
      if ((i & ((1 << shift) - 1)) === 0) {
        this.#minIdx[k][j] = i;
        this.#maxIdx[k][j] = i;
      } else {
        if (v < this.values[this.#minIdx[k][j]]) this.#minIdx[k][j] = i;
        if (v > this.values[this.#maxIdx[k][j]]) this.#maxIdx[k][j] = i;
      }
    }
  }

  /**
   * Indices of the min and max value in `[lo, hi)` (hi > lo, hi ≤ length).
   * Ties keep the earliest index.
   */
  query(lo: number, hi: number, out: [number, number]): [number, number] {
    const { values } = this;
    let mn = lo;
    let mx = lo;
    const levels = this.levels;
    let i = lo;
    while (i < hi) {
      // Largest aligned complete block starting at i.
      let k = -1;
      while (k + 1 < levels) {
        const size = 1 << (PYRAMID_BASE_LOG2 + k + 1);
        if ((i & (size - 1)) !== 0 || i + size > hi) break;
        k++;
      }
      if (k < 0) {
        const v = values[i];
        if (v < values[mn]) mn = i;
        if (v > values[mx]) mx = i;
        i++;
      } else {
        const shift = PYRAMID_BASE_LOG2 + k;
        const j = i >>> shift;
        const bMin = this.#minIdx[k][j];
        const bMax = this.#maxIdx[k][j];
        if (values[bMin] < values[mn]) mn = bMin;
        if (values[bMax] > values[mx]) mx = bMax;
        i += 1 << shift;
      }
    }
    out[0] = mn;
    out[1] = mx;
    return out;
  }
}

/** Min/max of `values[lo..hi)` by scanning (no pyramid). */
export const scanMinMax = (
  values: Float64Array,
  lo: number,
  hi: number,
  out: [number, number],
): [number, number] => {
  let mn = lo;
  let mx = lo;
  for (let i = lo + 1; i < hi; i++) {
    const v = values[i];
    if (v < values[mn]) mn = i;
    if (v > values[mx]) mx = i;
  }
  out[0] = mn;
  out[1] = mx;
  return out;
};

export type RangeMinMax = (
  lo: number,
  hi: number,
  out: [number, number],
) => [number, number];

/**
 * Time buckets for a window: `bucketMs` aligned to multiples of itself since
 * the epoch, so the same instant always falls in the same bucket. Panning then
 * reselects the same points for the overlapping part (no shimmer), and the
 * live edge only changes its last bucket.
 */
export const alignedBuckets = (
  start: number,
  end: number,
  bucketMs: number,
) => {
  const first = Math.floor(start / bucketMs) * bucketMs;
  const count = Math.max(0, Math.ceil((end - first) / bucketMs));
  return { first, count };
};

/** Smallest "nice" bucket ≥ `minMs` (1, 2, 5 × 10^n ms). */
export const niceBucketMs = (minMs: number) => {
  if (!(minMs > 1)) return 1;
  const p = 10 ** Math.floor(Math.log10(minMs));
  for (const m of [1, 2, 5, 10]) if (m * p >= minMs) return m * p;
  return 10 * p;
};

/**
 * M4: per time bucket in `[start, end)`, the indices of the first, min, max
 * and last point, ascending and without duplicates. Empty buckets add
 * nothing. `minMax` answers the range min/max (a pyramid's query, or
 * scanMinMax).
 */
export const m4Indices = (
  { times, length }: SeriesArrays,
  start: number,
  end: number,
  bucketMs: number,
  minMax: RangeMinMax,
): number[] => {
  const { first, count } = alignedBuckets(start, end, bucketMs);
  const out: number[] = [];
  const mm: [number, number] = [0, 0];
  let lo = lowerBound(times, first, 0, length);
  for (let b = 0; b < count && lo < length; b++) {
    const bucketEnd = first + (b + 1) * bucketMs;
    if (times[lo] >= bucketEnd) {
      // Skip empty buckets in one jump.
      b = Math.floor((times[lo] - first) / bucketMs) - 1;
      continue;
    }
    const hi = lowerBound(times, bucketEnd, lo, length);
    const last = hi - 1;
    out.push(lo);
    if (hi - lo > 2) {
      minMax(lo, hi, mm);
      const a = Math.min(mm[0], mm[1]);
      const c = Math.max(mm[0], mm[1]);
      if (a !== lo && a !== last) out.push(a);
      if (c !== a && c !== lo && c !== last) out.push(c);
    }
    if (last !== lo) out.push(last);
    lo = hi;
  }
  return out;
};

/**
 * Min and max indices (ascending) per time bucket: the MinMaxLTTB
 * preselection (first/last are added by the caller).
 */
export const minMaxIndices = (
  { times, length }: SeriesArrays,
  start: number,
  end: number,
  bucketMs: number,
  minMax: RangeMinMax,
): number[] => {
  const { first, count } = alignedBuckets(start, end, bucketMs);
  const out: number[] = [];
  const mm: [number, number] = [0, 0];
  let lo = lowerBound(times, first, 0, length);
  for (let b = 0; b < count && lo < length; b++) {
    const bucketEnd = first + (b + 1) * bucketMs;
    if (times[lo] >= bucketEnd) {
      b = Math.floor((times[lo] - first) / bucketMs) - 1;
      continue;
    }
    const hi = lowerBound(times, bucketEnd, lo, length);
    minMax(lo, hi, mm);
    const a = Math.min(mm[0], mm[1]);
    const c = Math.max(mm[0], mm[1]);
    out.push(a);
    if (c !== a) out.push(c);
    lo = hi;
  }
  return out;
};

/**
 * LTTB over the candidate indices `idx` (ascending): keeps the first and
 * last and, for each of `threshold - 2` equal-count buckets, the candidate
 * with the largest triangle against the previously kept point and the next
 * bucket's average. Returns `idx` unchanged when it is no longer than
 * `threshold`.
 */
export const lttbIndices = (
  { times, values }: SeriesArrays,
  idx: ArrayLike<number>,
  threshold: number,
): number[] => {
  const n = idx.length;
  if (threshold >= n || threshold < 3) return Array.from(idx);
  const out: number[] = [idx[0]];
  const every = (n - 2) / (threshold - 2);
  let a = 0; // position in idx of the last kept point
  for (let b = 0; b < threshold - 2; b++) {
    // next bucket's average (the last point for the final bucket)
    let avgStart = Math.floor((b + 1) * every) + 1;
    let avgEnd = Math.floor((b + 2) * every) + 1;
    if (avgEnd > n) avgEnd = n;
    if (avgStart >= avgEnd) avgStart = avgEnd - 1;
    let avgX = 0;
    let avgY = 0;
    for (let j = avgStart; j < avgEnd; j++) {
      avgX += times[idx[j]];
      avgY += values[idx[j]];
    }
    const len = avgEnd - avgStart;
    avgX /= len;
    avgY /= len;
    const rangeStart = Math.floor(b * every) + 1;
    const rangeEnd = Math.floor((b + 1) * every) + 1;
    const ax = times[idx[a]];
    const ay = values[idx[a]];
    let maxArea = -1;
    let next = rangeStart;
    for (let j = rangeStart; j < rangeEnd; j++) {
      const area = Math.abs(
        (ax - avgX) * (values[idx[j]] - ay) -
          (ax - times[idx[j]]) * (avgY - ay),
      );
      if (area > maxArea) {
        maxArea = area;
        next = j;
      }
    }
    out.push(idx[next]);
    a = next;
  }
  out.push(idx[n - 1]);
  return out;
};

/** Indices of `[lo, hi)` as an array (raw / LTTB input). */
export const rangeIndices = (lo: number, hi: number) => {
  const out = new Uint32Array(Math.max(0, hi - lo));
  for (let i = 0; i < out.length; i++) out[i] = lo + i;
  return out;
};

/**
 * Merge the points either side of each gap into a sorted selection and mark
 * where the line must break. `gaps` holds indices g (ascending) with
 * `times[g] - times[g - 1]` over the gap threshold. Returns the selection and,
 * for each position p > 0, whether a break goes between p - 1 and p.
 */
export const withGaps = (
  selected: number[],
  gaps: readonly number[],
): { indices: number[]; breaks: Set<number> } => {
  if (selected.length === 0 || gaps.length === 0)
    return { indices: selected, breaks: new Set() };
  const lo = selected[0];
  const hi = selected[selected.length - 1];
  const extra: number[] = [];
  for (const g of gaps) {
    if (g <= lo) continue;
    if (g > hi) break;
    extra.push(g - 1, g);
  }
  let indices = selected;
  if (extra.length) {
    indices = Array.from(new Set([...selected, ...extra])).sort(
      (x, y) => x - y,
    );
  }
  const breaks = new Set<number>();
  let gi = 0;
  for (let p = 1; p < indices.length; p++) {
    while (gi < gaps.length && gaps[gi] <= indices[p - 1]) gi++;
    if (gi < gaps.length && gaps[gi] <= indices[p]) breaks.add(p);
  }
  return { indices, breaks };
};
