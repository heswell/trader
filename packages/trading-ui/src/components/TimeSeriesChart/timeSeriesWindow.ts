import {
  bucketWidthFor,
  TIME_SERIES_MAX_POINTS,
} from "@heswell/trading-schemas";

/** One field's points for echarts: [time, value | null]. */
export type SeriesPoints = [number, number | null][];

/** The columns of a `timeSeriesBuckets` row the chart reads. */
export const BUCKET_COLUMNS = [
  "id",
  "field",
  "bucket",
  "width",
  "firstT",
  "first",
  "minT",
  "min",
  "maxT",
  "max",
  "lastT",
  "last",
] as const;

export interface BucketRow {
  field: string;
  bucket: number;
  width: number;
  firstT: number;
  first: number;
  minT: number;
  min: number;
  maxT: number;
  max: number;
  lastT: number;
  last: number;
}

/** Share of the visible span subscribed either side (the viewport buffer). */
export const OVERSCAN = 0.5;

export interface ViewState {
  /** Visible time range. */
  start: number;
  end: number;
  /** Plot width in pixels. */
  widthPx: number;
  /** Store interval: the finest bucket width. */
  baseMs: number;
  /** The view is pinned to the live edge. */
  follow: boolean;
}

/** The window to subscribe: what setTimeSeriesWindow is sent. */
export interface WindowPlan {
  start: number;
  end: number;
  points: number;
  follow: boolean;
  /** Bucket width the server will publish for it. */
  width: number;
}

/**
 * The subscribed window for a view: the visible span plus OVERSCAN either
 * side, with one point per pixel column (about one bucket per column: the
 * width is the largest base × 2^k not wider than a pixel). Following, the
 * window ends at now and the server slides it.
 */
export const planWindow = (
  { start, end, widthPx, baseMs, follow }: ViewState,
  overscan = OVERSCAN,
): WindowPlan => {
  const span = end - start;
  const pad = span * overscan;
  const columns = Math.max(1, widthPx) * (1 + (follow ? 1 : 2) * overscan);
  const points = Math.min(TIME_SERIES_MAX_POINTS, Math.ceil(columns));
  const from = start - pad;
  const to = follow ? end : end + pad;
  return {
    start: from,
    end: to,
    points,
    follow,
    width: bucketWidthFor(to - from, points, baseMs),
  };
};

/** The bucket range the server holds for a plan (as BucketWindow does). */
export const planRange = (plan: WindowPlan, now: number) => {
  const span = plan.end - plan.start;
  const end = plan.follow ? now : plan.end;
  const from = Math.floor((end - span) / plan.width) * plan.width;
  const to = (Math.floor((end - 1) / plan.width) + 1) * plan.width;
  return { from, to };
};

/**
 * True when the subscription no longer serves the view: none yet, follow
 * changed, a different bucket width level, or the view left the subscribed
 * range on a side that has data (before `first`, there is none).
 */
export const needsWindow = (
  current: (WindowPlan & { from: number; to: number }) | undefined,
  view: ViewState,
  first: number,
) => {
  if (!current) return true;
  if (current.follow !== view.follow) return true;
  if (planWindow(view).width !== current.width) return true;
  if (view.start < current.from && current.from > first) return true;
  if (!view.follow && view.end > current.to) return true;
  return false;
};

/**
 * Bucket rows (any order) to line points per field: each bucket's first,
 * min, max and last in time order, a null where the step to the next bucket
 * is over `gapMs`. Rows of another width (stale, mid-reset) are skipped.
 */
export const bucketsToPoints = (
  rows: readonly BucketRow[],
  width: number,
  gapMs: number,
): Record<string, SeriesPoints> => {
  const byField: Record<string, BucketRow[]> = {};
  for (const row of rows) {
    if (row.width !== width) continue;
    const list = byField[row.field];
    if (list) list.push(row);
    else byField[row.field] = [row];
  }
  const out: Record<string, SeriesPoints> = {};
  for (const [field, list] of Object.entries(byField)) {
    list.sort((a, b) => a.bucket - b.bucket);
    const points: SeriesPoints = [];
    let lastT = Number.NaN;
    for (const r of list) {
      if (r.firstT - lastT > gapMs)
        points.push([Math.round((lastT + r.firstT) / 2), null]);
      const four: [number, number][] = [
        [r.firstT, r.first],
        [r.minT, r.min],
        [r.maxT, r.max],
        [r.lastT, r.last],
      ];
      four.sort((x, y) => x[0] - y[0]);
      for (let i = 0; i < 4; i++)
        if (i === 0 || four[i][0] !== four[i - 1][0]) points.push(four[i]);
      lastT = r.lastT;
    }
    out[field] = points;
  }
  return out;
};
