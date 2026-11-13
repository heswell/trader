import type { SetTimeSeriesWindowResponse } from "@heswell/trading-schemas";
import { resolveChartTheme } from "@vuu-ui/vuu-chart";
import { LineChart } from "echarts/charts";
import {
  DataZoomInsideComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
} from "echarts/components";
import { type ECharts, init, use } from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import {
  type BucketRow,
  bucketsToPoints,
  needsWindow,
  planRange,
  planWindow,
  type SeriesPoints,
  type ViewState,
  type WindowPlan,
} from "./timeSeriesWindow";

// Same echarts as vuu-chart (6.1.0): registering again is a no-op.
use([
  LineChart,
  DataZoomInsideComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  CanvasRenderer,
]);

/** Numbers for the stats readout. */
export interface TimeSeriesStats {
  /** Last window change: buckets held, rows sent / removed by it. */
  buckets: number;
  upserts: number;
  removed: number;
  bucketMs: number;
  serverMs: number;
  /** Request to answer, client side. */
  roundTripMs: number;
  /** Visible span. */
  spanMs: number;
  following: boolean;
  /** Window changes sent so far (not counting keep-alives). */
  windowRequests: number;
  /** Row updates received (frames with changes) so far. */
  rowUpdates: number;
  /** Bucket rows held (all widths, all fields). */
  rows: number;
}

export interface TimeSeriesWindowRequest {
  start: number;
  end: number;
  points: number;
  follow: boolean;
}

export interface TimeSeriesControllerOptions {
  fields: readonly string[];
  /** Initial visible span, ending now. */
  spanMs: number;
  /** Fields drawn as step-hold (`step: "end"`), e.g. P&L. */
  stepFields?: readonly string[];
  /** Debounce of the window change after a zoom / pan (ms). */
  debounceMs?: number;
  /** Send setTimeSeriesWindow for this subscription. */
  send: (
    window: TimeSeriesWindowRequest,
  ) => Promise<SetTimeSeriesWindowResponse>;
  onStats?: (stats: TimeSeriesStats) => void;
  onError?: (error: unknown) => void;
}

const GRID = { left: 64, right: 64, top: 16, bottom: 56 };
/** Smallest visible span: a minute. */
const MIN_SPAN_MS = 60_000;
/** Re-send the window this often to keep the subscription's lease. */
const KEEP_ALIVE_MS = 20_000;

type Current = WindowPlan & { from: number; to: number };

/**
 * Drives one echarts line chart over a time-series subscription, like a
 * grid over a viewport: the chart owns a window (visible span plus overscan,
 * about one bucket per pixel) and sends setTimeSeriesWindow when the view
 * leaves it or needs another bucket width; the server streams the buckets as
 * `timeSeriesBuckets` rows (setRows) and keeps them up to date as data
 * ticks. Pinned to the live edge, the window follows now on the server and
 * the view follows it here.
 */
export class TimeSeriesController {
  readonly #chart: ECharts;
  readonly #options: TimeSeriesControllerOptions;
  #current: Current | undefined;
  #rows: readonly BucketRow[] = [];
  #series: Record<string, SeriesPoints> = {};
  #first = 0;
  /** Server clock minus local clock. */
  #clockOffset = 0;
  #baseMs = 1000;
  #gapMs = 3000;
  #view = { start: 0, end: 0 };
  #following = true;
  #debounce: ReturnType<typeof setTimeout> | undefined;
  #liveTimer: ReturnType<typeof setInterval> | undefined;
  #seq = 0;
  #lastSent = 0;
  #disposed = false;
  #settingZoom = false;
  #stats: TimeSeriesStats = {
    buckets: 0,
    upserts: 0,
    removed: 0,
    bucketMs: 0,
    serverMs: 0,
    roundTripMs: 0,
    spanMs: 0,
    following: true,
    windowRequests: 0,
    rowUpdates: 0,
    rows: 0,
  };

  constructor(
    readonly element: HTMLElement,
    options: TimeSeriesControllerOptions,
  ) {
    this.#options = options;
    this.#chart = init(element, undefined, { renderer: "canvas" });
    this.#chart.on("datazoom", this.#onDataZoom);
    const now = Date.now();
    this.#first = now - options.spanMs;
    this.#view = { start: now - options.spanMs, end: now };
    this.#render();
    void this.#sendWindow();
    this.#liveTimer = setInterval(this.#onLive, 1000);
  }

  get #now() {
    return Date.now() + this.#clockOffset;
  }

  get #widthPx() {
    return Math.max(1, this.#chart.getWidth() - GRID.left - GRID.right);
  }

  #viewState(): ViewState {
    return {
      ...this.#view,
      widthPx: this.#widthPx,
      baseMs: this.#baseMs,
      follow: this.#following,
    };
  }

  /** The subscription's rows changed (all rows held, any order). */
  setRows(rows: readonly BucketRow[]) {
    this.#rows = rows;
    this.#stats.rowUpdates++;
    this.#stats.rows = rows.length;
    this.#redraw();
  }

  #redraw() {
    if (this.#disposed || !this.#current) return;
    this.#series = bucketsToPoints(
      this.#rows,
      this.#current.width,
      this.#gapMs,
    );
    this.#chart.setOption({ series: this.#seriesOptions() });
  }

  #seriesOptions() {
    const { fields, stepFields = [] } = this.#options;
    const series = this.#series;
    return fields.map((field, i) => ({
      id: field,
      name: field,
      type: "line" as const,
      yAxisIndex: Math.min(i, 1),
      showSymbol: false,
      connectNulls: false,
      animation: false,
      step: stepFields.includes(field) ? ("end" as const) : false,
      lineStyle: { width: 1 },
      emphasis: { disabled: true },
      data: series[field] ?? [],
    }));
  }

  #render() {
    const theme = resolveChartTheme(this.element);
    const { fields } = this.#options;
    const axis = {
      axisLine: { lineStyle: { color: theme.axisLineColor } },
      axisLabel: { color: theme.secondaryForegroundColor },
      splitLine: { lineStyle: { color: theme.splitLineColor } },
    };
    this.#settingZoom = true;
    this.#chart.setOption(
      {
        animation: false,
        backgroundColor: "transparent",
        color: theme.palette,
        textStyle: { fontFamily: theme.fontFamily },
        grid: GRID,
        legend: {
          top: "bottom",
          textStyle: { color: theme.foregroundColor },
        },
        tooltip: {
          trigger: "axis",
          backgroundColor: theme.tooltipBackgroundColor,
          borderColor: theme.tooltipBorderColor,
          textStyle: { color: theme.foregroundColor },
        },
        xAxis: {
          type: "time",
          min: this.#first,
          max: this.#view.end,
          ...axis,
          splitLine: { show: false },
        },
        yAxis: fields.slice(0, 2).map((field, i) => ({
          type: "value",
          name: field,
          scale: true,
          ...axis,
          ...(i > 0 ? { splitLine: { show: false } } : {}),
        })),
        dataZoom: [
          {
            type: "inside",
            xAxisIndex: 0,
            filterMode: "weakFilter",
            rangeMode: ["value", "value"],
            startValue: this.#view.start,
            endValue: this.#view.end,
            minValueSpan: MIN_SPAN_MS,
          },
        ],
        series: this.#seriesOptions(),
      },
      { lazyUpdate: false },
    );
    this.#settingZoom = false;
  }

  /** Visible window from the dataZoom percent range over the axis extent. */
  #readZoom() {
    const option = this.#chart.getOption() as {
      dataZoom?: { start?: number; end?: number }[];
      xAxis?: { min?: number; max?: number }[];
    };
    const dz = option.dataZoom?.[0];
    const axis = option.xAxis?.[0];
    if (!dz || axis?.min === undefined || axis.max === undefined) return;
    const lo = axis.min;
    const span = axis.max - lo;
    this.#view = {
      start: lo + (span * (dz.start ?? 0)) / 100,
      end: lo + (span * (dz.end ?? 100)) / 100,
    };
  }

  readonly #onDataZoom = () => {
    if (this.#settingZoom) return;
    this.#readZoom();
    const pixelMs = (this.#view.end - this.#view.start) / this.#widthPx;
    this.#following = this.#view.end >= this.#now - 2 * Math.max(pixelMs, 1000);
    clearTimeout(this.#debounce);
    this.#debounce = setTimeout(
      () => this.#maybeWindow(),
      this.#options.debounceMs ?? 120,
    );
  };

  #maybeWindow() {
    if (needsWindow(this.#current, this.#viewState(), this.#first))
      void this.#sendWindow();
  }

  async #sendWindow(plan = planWindow(this.#viewState()), keepAlive = false) {
    const seq = ++this.#seq;
    const t0 = performance.now();
    this.#lastSent = Date.now();
    try {
      const res = await this.#options.send({
        start: Math.max(0, Math.round(plan.start)),
        end: Math.round(plan.end),
        points: plan.points,
        follow: plan.follow,
      });
      if (this.#disposed || seq !== this.#seq) return;
      this.#clockOffset = res.now - Date.now();
      this.#baseMs = res.intervalMs;
      this.#gapMs = res.gapMs;
      if (res.first) this.#first = res.first;
      this.#current = {
        ...plan,
        width: res.bucketMs,
        from: res.from,
        to: res.to,
      };
      if (!keepAlive) {
        this.#stats = {
          ...this.#stats,
          buckets: res.buckets,
          upserts: res.upserts,
          removed: res.removed,
          bucketMs: res.bucketMs,
          serverMs: res.serverMs,
          roundTripMs: performance.now() - t0,
          spanMs: this.#view.end - this.#view.start,
          following: plan.follow,
          windowRequests: this.#stats.windowRequests + 1,
        };
        this.#options.onStats?.({ ...this.#stats });
      }
      this.#moveAxis();
      this.#redraw();
    } catch (err) {
      this.#options.onError?.(err);
    }
  }

  /** Every second: the live edge moves; a following view moves with it. */
  readonly #onLive = () => {
    if (this.#disposed || !this.#current) return;
    if (this.#following) {
      const now = this.#now;
      const span = this.#view.end - this.#view.start;
      this.#view = { start: now - span, end: now };
      const range = planRange(this.#current, now);
      this.#current = { ...this.#current, ...range };
    }
    this.#moveAxis();
    this.#options.onStats?.({ ...this.#stats });
    if (Date.now() - this.#lastSent > KEEP_ALIVE_MS && this.#current)
      void this.#sendWindow(this.#current, true);
  };

  #moveAxis() {
    this.#settingZoom = true;
    this.#chart.setOption({
      xAxis: { min: this.#first, max: Math.max(this.#now, this.#view.end) },
      dataZoom: [{ startValue: this.#view.start, endValue: this.#view.end }],
    });
    this.#settingZoom = false;
  }

  /** Show the last `spanMs` (at most everything) up to now and follow the live edge. */
  showLatest(spanMs: number) {
    this.#following = true;
    const now = this.#now;
    this.#view = { start: Math.max(this.#first, now - spanMs), end: now };
    this.#moveAxis();
    this.#maybeWindow();
  }

  resize() {
    this.#chart.resize();
    if (this.#current) this.#maybeWindow();
  }

  dispose() {
    this.#disposed = true;
    clearTimeout(this.#debounce);
    clearInterval(this.#liveTimer);
    this.#chart.dispose();
  }
}
