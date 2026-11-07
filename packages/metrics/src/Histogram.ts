/** Sub-buckets per power of two: 16 gives buckets about 6% wide. */
const SUB_BITS = 4;
const SUB = 1 << SUB_BITS;
const SUB_MASK = SUB - 1;
/** Powers of two covered: values up to 2^32 (in µs, about 71 minutes). */
const OCTAVES = 32;
const MAX_INT = 0xffff_ffff;

/** Bucket of a value: 0 for values below 1, else log-linear. */
const bucketOf = (value: number) => {
  if (!(value >= 1)) return 0;
  const v = value >= MAX_INT ? MAX_INT : value >>> 0;
  const e = 31 - Math.clz32(v);
  const sub =
    e >= SUB_BITS
      ? (v >>> (e - SUB_BITS)) & SUB_MASK
      : (v << (SUB_BITS - e)) & SUB_MASK;
  return 1 + e * SUB + sub;
};

/** Middle of a bucket's range. */
const bucketMid = (index: number) => {
  if (index === 0) return 0.5;
  const e = Math.floor((index - 1) / SUB);
  const sub = (index - 1) % SUB;
  return 2 ** e * (1 + (sub + 0.5) / SUB);
};

/**
 * Fixed-size, log-linear histogram for latencies (by convention in µs).
 * `record` does not allocate: one bucket calculation and a few field writes,
 * so it is safe on a hot path. Percentiles are read off the hot path (by the
 * metrics collector) and are accurate to about 3% (half a bucket), clamped to
 * the exact min and max.
 */
export class Histogram {
  readonly #counts = new Uint32Array(1 + OCTAVES * SUB);
  count = 0;
  sum = 0;
  min = Number.POSITIVE_INFINITY;
  max = 0;

  record(value: number) {
    this.count++;
    this.sum += value;
    if (value < this.min) this.min = value;
    if (value > this.max) this.max = value;
    this.#counts[bucketOf(value)]++;
  }

  get mean() {
    return this.count === 0 ? 0 : this.sum / this.count;
  }

  /** Value at quantile `q` (0..1); 0 when empty. */
  percentile(q: number) {
    if (this.count === 0) return 0;
    const target = Math.max(1, Math.ceil(q * this.count));
    const counts = this.#counts;
    let seen = 0;
    for (let i = 0; i < counts.length; i++) {
      seen += counts[i];
      if (seen >= target) {
        // the top bucket also holds everything above its range
        if (i === counts.length - 1) return this.max;
        return Math.min(this.max, Math.max(this.min, bucketMid(i)));
      }
    }
    return this.max;
  }

  reset() {
    this.#counts.fill(0);
    this.count = 0;
    this.sum = 0;
    this.min = Number.POSITIVE_INFINITY;
    this.max = 0;
  }
}
