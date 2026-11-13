/**
 * Visual error of a downsampled line: rasterize both lines into a
 * `width` × `height` canvas over the same window and y range, and compare
 * the vertical extent each line covers in every pixel column. 0 means the
 * same pixels are lit (for a 1px line without anti-aliasing).
 */

export interface LinePoints {
  times: ArrayLike<number>;
  /** null = gap (no segment to or from this point). */
  values: ArrayLike<number | null>;
}

export interface RasterOptions {
  start: number;
  end: number;
  width: number;
  height: number;
  yMin: number;
  yMax: number;
}

/** Per column [lowest row, highest row] lit by the line (NaN = none). */
export const rasterColumns = (
  { times, values }: LinePoints,
  { start, end, width, height, yMin, yMax }: RasterOptions,
) => {
  const lo = new Float64Array(width).fill(Number.NaN);
  const hi = new Float64Array(width).fill(Number.NaN);
  const xs = width / (end - start);
  const ys = yMax > yMin ? (height - 1) / (yMax - yMin) : 0;
  const mark = (c: number, y: number) => {
    if (c < 0 || c >= width) return;
    const row = Math.round((y - yMin) * ys);
    if (!(row >= lo[c])) lo[c] = row;
    if (!(row <= hi[c])) hi[c] = row;
  };
  for (let i = 1; i < times.length; i++) {
    const v0 = values[i - 1];
    const v1 = values[i];
    if (v0 === null || v1 === null) continue;
    let x0 = (times[i - 1] - start) * xs;
    let x1 = (times[i] - start) * xs;
    if (x1 < 0 || x0 >= width) continue;
    let y0 = v0;
    let y1 = v1;
    const slope = x1 > x0 ? (y1 - y0) / (x1 - x0) : 0;
    if (x0 < 0) {
      y0 += slope * -x0;
      x0 = 0;
    }
    if (x1 > width) {
      y1 -= slope * (x1 - width);
      x1 = width;
    }
    const c0 = Math.floor(x0);
    const c1 = Math.min(width - 1, Math.floor(x1));
    for (let c = c0; c <= c1; c++) {
      const xa = Math.max(x0, c);
      const xb = Math.min(x1, c + 1);
      mark(c, y0 + slope * (xa - x0));
      mark(c, y0 + slope * (xb - x0));
    }
  }
  return { lo, hi };
};

/**
 * Compare a downsampled line with the full one: `meanPx` mean |Δ| of the
 * column extents (rows), `columns` share of columns that differ at all.
 */
export const rasterError = (
  full: LinePoints,
  sampled: LinePoints,
  options: RasterOptions,
) => {
  const a = rasterColumns(full, options);
  const b = rasterColumns(sampled, options);
  let sum = 0;
  let differ = 0;
  let counted = 0;
  for (let c = 0; c < options.width; c++) {
    const aLit = !Number.isNaN(a.lo[c]);
    const bLit = !Number.isNaN(b.lo[c]);
    if (!aLit && !bLit) continue;
    counted++;
    if (aLit !== bLit) {
      differ++;
      sum += options.height / 4;
      continue;
    }
    const d = Math.abs(a.lo[c] - b.lo[c]) + Math.abs(a.hi[c] - b.hi[c]);
    if (d > 0) differ++;
    sum += d;
  }
  return {
    meanPx: counted ? sum / counted : 0,
    columns: counted ? differ / counted : 0,
  };
};
