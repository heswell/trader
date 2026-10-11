/**
 * Fixed-capacity ring buffer of numbers (oldest overwritten first).
 * Backed by a Float64Array, so memory is `capacity * 8` bytes with no
 * per-tick allocation.
 */
export class SparklineBuffer {
  readonly capacity: number;
  #values: Float64Array;
  #start = 0;
  #length = 0;
  /** Start of the time bucket of the newest sample (bucketed series only). */
  lastBucket = Number.NEGATIVE_INFINITY;

  constructor(capacity: number) {
    this.capacity = Math.max(2, Math.floor(capacity));
    this.#values = new Float64Array(this.capacity);
  }

  get length() {
    return this.#length;
  }

  get last(): number | undefined {
    return this.#length === 0 ? undefined : this.at(this.#length - 1);
  }

  /** i = 0 is the oldest retained sample. */
  at(i: number) {
    return this.#values[(this.#start + i) % this.capacity];
  }

  push(value: number) {
    if (this.#length < this.capacity) {
      this.#values[(this.#start + this.#length) % this.capacity] = value;
      this.#length += 1;
    } else {
      this.#values[this.#start] = value;
      this.#start = (this.#start + 1) % this.capacity;
    }
  }

  /** Replace the newest sample (a tick landing in the current time bucket). */
  replaceLast(value: number) {
    if (this.#length === 0) this.push(value);
    else this.#values[(this.#start + this.#length - 1) % this.capacity] = value;
  }

  clear() {
    this.#start = 0;
    this.#length = 0;
    this.lastBucket = Number.NEGATIVE_INFINITY;
  }

  toArray() {
    const out = new Array<number>(this.#length);
    for (let i = 0; i < this.#length; i++) out[i] = this.at(i);
    return out;
  }
}

export interface SparklineSampling {
  /**
   * 0 (default): one sample per change of the value. > 0: time buckets of this
   * many ms, each holding the latest value in the bucket, so the chart has a
   * constant time axis however fast the instrument ticks.
   */
  bucketMs?: number;
  now?: () => number;
}

/** Add `value` to `buffer` per the sampling rule; true if the buffer changed. */
export const recordSample = (
  buffer: SparklineBuffer,
  value: number,
  { bucketMs = 0, now = Date.now }: SparklineSampling = {},
) => {
  if (!Number.isFinite(value)) return false;
  if (bucketMs > 0) {
    const bucket = Math.floor(now() / bucketMs);
    if (bucket === buffer.lastBucket) {
      if (buffer.last === value) return false;
      buffer.replaceLast(value);
      return true;
    }
    buffer.lastBucket = bucket;
    buffer.push(value);
    return true;
  }
  if (buffer.last === value) return false;
  buffer.push(value);
  return true;
};

/**
 * SVG polyline `points` for a buffer in a `width` x `height` box, y inverted.
 * A flat series is drawn mid-height.
 */
export const sparklinePoints = (
  buffer: SparklineBuffer,
  width: number,
  height: number,
  padding = 1,
) => {
  const n = buffer.length;
  if (n < 2) return "";
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < n; i++) {
    const v = buffer.at(i);
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min;
  const usable = height - padding * 2;
  // x is positioned from the right so a partially filled buffer grows leftwards
  // at constant spacing, as capacity-1 intervals span the width.
  const step = width / (buffer.capacity - 1);
  const x0 = width - (n - 1) * step;
  let points = "";
  for (let i = 0; i < n; i++) {
    const y =
      range === 0
        ? height / 2
        : padding + usable - ((buffer.at(i) - min) / range) * usable;
    points += `${i ? " " : ""}${(x0 + i * step).toFixed(1)},${y.toFixed(1)}`;
  }
  return points;
};

/**
 * Per-row series, shared by every cell showing the same key. Reference
 * counted: a series is created when the first cell for a row mounts and freed
 * when the last one unmounts or is recycled to another row, i.e. when the row
 * leaves the viewport.
 */
export class SparklineStore {
  #entries = new Map<string, { buffer: SparklineBuffer; refs: number }>();

  acquire(key: string, capacity: number) {
    let entry = this.#entries.get(key);
    if (!entry || entry.buffer.capacity !== Math.max(2, Math.floor(capacity))) {
      entry = { buffer: new SparklineBuffer(capacity), refs: 0 };
      this.#entries.set(key, entry);
    }
    entry.refs += 1;
    return entry.buffer;
  }

  release(key: string, buffer: SparklineBuffer) {
    const entry = this.#entries.get(key);
    if (!entry || entry.buffer !== buffer) return;
    entry.refs -= 1;
    if (entry.refs <= 0) this.#entries.delete(key);
  }

  get size() {
    return this.#entries.size;
  }

  /** Bytes held by sample storage. */
  get bytes() {
    let bytes = 0;
    for (const { buffer } of this.#entries.values())
      bytes += buffer.capacity * 8;
    return bytes;
  }

  clear() {
    this.#entries.clear();
  }
}

/** Store used by the registered `trading.sparkline` cell renderer. */
export const sparklineStore = new SparklineStore();
