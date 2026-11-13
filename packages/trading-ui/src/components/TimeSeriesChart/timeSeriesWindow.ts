import {
  decodeTimeSeries,
  type DownsampleMethod,
  TIME_SERIES_MAX_POINTS,
  type TimeSeriesResponse,
} from "@heswell/trading-schemas";

/** One field's points for echarts: [time, value | null]. */
export type SeriesPoints = [number, number | null][];

/** What the chart holds: a window of downsampled points per field. */
export interface LoadedWindow {
  start: number;
  end: number;
  /** ms per pixel the window was requested at. */
  pixelMs: number;
  method: DownsampleMethod;
  series: Record<string, SeriesPoints>;
}

export interface ViewState {
  /** Visible time range. */
  start: number;
  end: number;
  /** Plot width in pixels. */
  widthPx: number;
  method: DownsampleMethod;
  /** Server clock (the live edge). */
  now: number;
}

export interface WindowRequest {
  start: number;
  end: number;
  points: number;
  bucketMs?: number;
  pixelMs: number;
}

/**
 * Samples per pixel column by method: M4 keeps up to 4 per bucket (one
 * bucket per pixel, pixel-exact); the LTTB variants and raw need fewer for a
 * similar look.
 */
export const POINTS_PER_PIXEL: Record<DownsampleMethod, number> = {
  m4: 4,
  minmaxlttb: 2,
  lttb: 2,
  raw: 2,
};

/** Share of the visible span loaded either side, so a pan needs no request. */
export const OVERSCAN = 0.5;

/**
 * The request for a view: the visible span plus OVERSCAN either side (not
 * past the live edge), snapped to the pixel grid (`pixelMs` = visible span /
 * width), so M4's buckets are pixel columns and the same instant always
 * falls in the same bucket when panning.
 */
export const planRequest = (
  { start, end, widthPx, method, now }: ViewState,
  overscan = OVERSCAN,
): WindowRequest => {
  const span = end - start;
  const pixelMs = Math.max(1, Math.ceil(span / Math.max(1, widthPx)));
  const pad = span * overscan;
  const from = Math.floor((start - pad) / pixelMs) * pixelMs;
  const to = Math.ceil(Math.min(end + pad, now + pixelMs) / pixelMs) * pixelMs;
  const columns = Math.max(1, Math.round((to - from) / pixelMs));
  const perPixel = POINTS_PER_PIXEL[method];
  const points = Math.min(
    TIME_SERIES_MAX_POINTS,
    Math.max(8, columns * perPixel),
  );
  return method === "m4"
    ? { start: from, end: to, points, bucketMs: pixelMs, pixelMs }
    : { start: from, end: to, points, pixelMs };
};

/**
 * True when the loaded window no longer serves the view: a different
 * method, zoomed more than 10% from the loaded resolution, or panned out of
 * the loaded range (on a side that has more data: before `first`, after
 * `now`, there is none).
 */
export const needsRequest = (
  loaded: LoadedWindow | undefined,
  view: ViewState,
  first: number,
) => {
  if (!loaded) return true;
  if (loaded.method !== view.method) return true;
  const pixelMs = (view.end - view.start) / Math.max(1, view.widthPx);
  const ratio = pixelMs / loaded.pixelMs;
  if (ratio < 0.9 || ratio > 1.1) return true;
  if (view.start < loaded.start && loaded.start > first) return true;
  if (view.end > loaded.end && loaded.end < view.now) return true;
  return false;
};

/** Decode every field of a response into echarts points. */
export const toPoints = (res: TimeSeriesResponse) => {
  const series: Record<string, SeriesPoints> = {};
  for (const s of res.series) {
    const { times, values } = decodeTimeSeries(s);
    series[s.field] = times.map((t, i) => [t, values[i]]);
  }
  return series;
};

/**
 * The live edge: replace the loaded points at or after `from` (the start of
 * the last, still filling, bucket) with the tail response's.
 */
export const mergeTail = (
  loaded: LoadedWindow,
  tail: TimeSeriesResponse,
  from: number,
): LoadedWindow => {
  const fresh = toPoints(tail);
  const series: Record<string, SeriesPoints> = {};
  for (const [field, points] of Object.entries(loaded.series)) {
    const kept = points.filter(([t]) => t < from);
    const added = (fresh[field] ?? []).filter(([t]) => t >= from);
    series[field] = kept.concat(added);
  }
  return { ...loaded, end: Math.max(loaded.end, tail.end), series };
};

/** Start of the bucket holding the last loaded point (the tail to refresh). */
export const tailStart = (loaded: LoadedWindow) => {
  let last = loaded.start;
  for (const points of Object.values(loaded.series)) {
    const t = points.at(-1)?.[0];
    if (t !== undefined && t > last) last = t;
  }
  return Math.floor(last / loaded.pixelMs) * loaded.pixelMs;
};
