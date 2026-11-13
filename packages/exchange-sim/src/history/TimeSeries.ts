import { MinMaxPyramid, type SeriesArrays, scanMinMax } from "./downsample";

/**
 * One growable time series in typed arrays (16 bytes per point) with a
 * min/max pyramid (about 0.5 bytes per point) kept up to date on append.
 * Times are strictly ascending. A step of more than `gapMs` between two
 * points is a gap: the line breaks there.
 */
export class TimeSeries implements SeriesArrays {
  times: Float64Array;
  values: Float64Array;
  length = 0;
  readonly pyramid: MinMaxPyramid;
  /** Indices g with `times[g] - times[g - 1] > gapMs`, ascending. */
  readonly gaps: number[] = [];

  constructor(
    readonly gapMs: number,
    capacity = 1024,
  ) {
    this.times = new Float64Array(capacity);
    this.values = new Float64Array(capacity);
    this.pyramid = new MinMaxPyramid(this.values);
  }

  /** A series holding `times` / `values` (taken over, not copied). */
  static from(
    times: Float64Array,
    values: Float64Array,
    gapMs: number,
    length = times.length,
  ) {
    const s = new TimeSeries(gapMs, 0);
    s.times = times;
    s.values = values;
    s.length = length;
    s.pyramid.grow(values, length);
    s.#scanGaps(1);
    return s;
  }

  #scanGaps(from: number) {
    const { times, gapMs } = this;
    for (let i = Math.max(1, from); i < this.length; i++)
      if (times[i] - times[i - 1] > gapMs) this.gaps.push(i);
  }

  get first() {
    return this.length ? this.times[0] : undefined;
  }
  get last() {
    return this.length ? this.times[this.length - 1] : undefined;
  }

  /** Bytes held (arrays at capacity + pyramid). */
  get bytes() {
    return this.times.byteLength + this.values.byteLength + this.pyramid.bytes;
  }

  /** Append a point after the last one (ignored unless later). */
  append(time: number, value: number) {
    const n = this.length;
    if (n > 0 && time <= this.times[n - 1]) return false;
    if (n === this.times.length) this.#grow(Math.max(1024, n * 2));
    this.times[n] = time;
    this.values[n] = value;
    this.length = n + 1;
    if (n > 0 && time - this.times[n - 1] > this.gapMs) this.gaps.push(n);
    this.pyramid.append(n);
    return true;
  }

  #grow(capacity: number) {
    const times = new Float64Array(capacity);
    const values = new Float64Array(capacity);
    times.set(this.times.subarray(0, this.length));
    values.set(this.values.subarray(0, this.length));
    this.times = times;
    this.values = values;
    this.pyramid.grow(values, this.length);
  }

  /**
   * A new series with `times` / `values` (all before this series' first
   * point) followed by this one. Used to put generated history in front of
   * the live points.
   */
  prepend(times: Float64Array, values: Float64Array): TimeSeries {
    const n = times.length + this.length;
    const t = new Float64Array(Math.max(1024, Math.ceil(n * 1.25)));
    const v = new Float64Array(t.length);
    t.set(times);
    v.set(values);
    t.set(this.times.subarray(0, this.length), times.length);
    v.set(this.values.subarray(0, this.length), times.length);
    return TimeSeries.from(t, v, this.gapMs, n);
  }

  /** Range min/max by the pyramid (`hi - lo` large) or a scan (small). */
  readonly minMax = (lo: number, hi: number, out: [number, number]) =>
    hi - lo <= 64
      ? scanMinMax(this.values, lo, hi, out)
      : this.pyramid.query(lo, hi, out);
}
