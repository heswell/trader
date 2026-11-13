import type {
  DownsampleMethod,
  TimeSeriesRequest,
  TimeSeriesResponse,
} from "@heswell/trading-schemas";
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
  type LoadedWindow,
  mergeTail,
  needsRequest,
  planRequest,
  tailStart,
  toPoints,
  type ViewState,
} from "./timeSeriesWindow";

/** Numbers from the last answered request, for the stats readout. */
export interface TimeSeriesStats {
  /** "window" (zoom / pan) or "tail" (live edge). */
  kind: "window" | "tail";
  method: DownsampleMethod;
  /** Samples returned, all fields. */
  returned: number;
  /** Store points inside the requested range, all fields. */
  sourcePoints: number;
  serverMs: number;
  /** Request to answer, client side. */
  roundTripMs: number;
  /** Size of the response data as JSON. */
  payloadBytes: number;
  bucketMs: number;
  /** Visible span. */
  spanMs: number;
  /** Window requests so far (not counting tails). */
  windowRequests: number;
}

export interface TimeSeriesControllerOptions {
  ric: string;
  fields: readonly string[];
  method: DownsampleMethod;
  /** Initial visible span, ending now. */
  spanMs: number;
  /** Fields drawn as step-hold (`step: "end"`), e.g. P&L. */
  stepFields?: readonly string[];
  /** Debounce of the window request after a zoom / pan (ms). */
  debounceMs?: number;
  send: (params: TimeSeriesRequest) => Promise<TimeSeriesResponse>;
  onStats?: (stats: TimeSeriesStats) => void;
  onError?: (error: unknown) => void;
}

// Same echarts as vuu-chart (6.1.0): registering again is a no-op.
use([
  LineChart,
  DataZoomInsideComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  CanvasRenderer,
]);

const GRID = { left: 64, right: 64, top: 16, bottom: 56 };
/** Smallest visible span: a minute. */
const MIN_SPAN_MS = 60_000;

/**
 * Drives one echarts line chart over the timeSeries RPC: zoom (wheel) and
 * pan (drag) move a dataZoom window over an x axis spanning everything the
 * store holds; a debounced request loads the window (plus overscan) at one
 * bucket per pixel. While the view touches the live edge it follows it,
 * refreshing just the last bucket every store interval.
 */
export class TimeSeriesController {
  readonly #chart: ECharts;
  readonly #options: TimeSeriesControllerOptions;
  #loaded: LoadedWindow | undefined;
  #first = 0;
  #now = 0;
  #intervalMs = 1000;
  #view = { start: 0, end: 0 };
  #following = true;
  #debounce: ReturnType<typeof setTimeout> | undefined;
  #liveTimer: ReturnType<typeof setInterval> | undefined;
  #seq = 0;
  #windowRequests = 0;
  #tailInFlight = false;
  #disposed = false;
  /** Ignore the dataZoom event our own setOption causes. */
  #settingZoom = false;

  constructor(
    readonly element: HTMLElement,
    options: TimeSeriesControllerOptions,
  ) {
    this.#options = options;
    this.#chart = init(element, undefined, { renderer: "canvas" });
    this.#chart.on("datazoom", this.#onDataZoom);
    void this.#start();
  }

  get #widthPx() {
    return Math.max(1, this.#chart.getWidth() - GRID.left - GRID.right);
  }

  #viewState(): ViewState {
    return {
      ...this.#view,
      widthPx: this.#widthPx,
      method: this.#options.method,
      now: this.#now,
    };
  }

  async #start() {
    const { ric, fields, spanMs, send } = this.#options;
    try {
      // A tiny probe for the extent and the server clock.
      const probe = await send({ ric, fields: fields.join(","), points: 8 });
      if (this.#disposed) return;
      this.#first = probe.first || probe.now - spanMs;
      this.#now = probe.now;
      this.#intervalMs = probe.intervalMs;
      this.#view = { start: probe.now - spanMs, end: probe.now };
      this.#render();
      await this.#requestWindow();
      this.#liveTimer = setInterval(this.#onLive, this.#intervalMs);
    } catch (err) {
      this.#options.onError?.(err);
    }
  }

  #seriesOptions() {
    const { fields, stepFields = [] } = this.#options;
    const series = this.#loaded?.series ?? {};
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
          max: this.#now,
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
    };
    const dz = option.dataZoom?.[0];
    if (!dz) return;
    const lo = this.#first;
    const span = this.#now - lo;
    this.#view = {
      start: lo + (span * (dz.start ?? 0)) / 100,
      end: lo + (span * (dz.end ?? 100)) / 100,
    };
  }

  readonly #onDataZoom = () => {
    if (this.#settingZoom) return;
    this.#readZoom();
    const pixelMs = (this.#view.end - this.#view.start) / this.#widthPx;
    this.#following = this.#view.end >= this.#now - 2 * pixelMs;
    clearTimeout(this.#debounce);
    this.#debounce = setTimeout(
      () => this.#maybeRequest(),
      this.#options.debounceMs ?? 120,
    );
  };

  #maybeRequest() {
    if (needsRequest(this.#loaded, this.#viewState(), this.#first))
      void this.#requestWindow();
  }

  async #requestWindow() {
    const { ric, fields, method, send } = this.#options;
    const plan = planRequest(this.#viewState());
    plan.start = Math.max(0, plan.start);
    const seq = ++this.#seq;
    const t0 = performance.now();
    try {
      const res = await send({
        ric,
        fields: fields.join(","),
        method,
        start: plan.start,
        end: plan.end,
        points: plan.points,
        ...(plan.bucketMs ? { bucketMs: plan.bucketMs } : {}),
      });
      // A later request supersedes this one.
      if (this.#disposed || seq !== this.#seq) return;
      this.#windowRequests++;
      this.#loaded = {
        start: res.start,
        end: res.end,
        pixelMs: plan.pixelMs,
        method,
        series: toPoints(res),
      };
      this.#first = res.first || this.#first;
      this.#advance(res.now - this.#now);
      this.#chart.setOption({ series: this.#seriesOptions() });
      this.#report("window", res, performance.now() - t0);
    } catch (err) {
      this.#options.onError?.(err);
    }
  }

  /** Every store interval: move the axis to now and, when following, the view. */
  readonly #onLive = async () => {
    const loaded = this.#loaded;
    if (!loaded || this.#tailInFlight || this.#disposed) return;
    const { ric, fields, method, send } = this.#options;
    if (method !== "m4") {
      // LTTB buckets are by index: a tail would not line up. Reload instead.
      if (this.#following) await this.#requestWindow();
      return;
    }
    if (!this.#following) return;
    const from = tailStart(loaded);
    this.#tailInFlight = true;
    const t0 = performance.now();
    try {
      const end = this.#now + 2 * this.#intervalMs + loaded.pixelMs;
      const res = await send({
        ric,
        fields: fields.join(","),
        method: "m4",
        start: from,
        end,
        bucketMs: loaded.pixelMs,
        points: Math.max(8, 4 * Math.ceil((end - from) / loaded.pixelMs)),
      });
      if (this.#disposed || this.#loaded !== loaded) return;
      this.#loaded = mergeTail(loaded, res, from);
      this.#advance(res.now - this.#now);
      this.#chart.setOption({ series: this.#seriesOptions() });
      this.#report("tail", res, performance.now() - t0);
    } catch (err) {
      this.#options.onError?.(err);
    } finally {
      this.#tailInFlight = false;
    }
  };

  /** Move the live edge (and a following view) on by `dt`. */
  #advance(dt: number) {
    if (!(dt > 0)) return;
    this.#now += dt;
    if (this.#following) {
      this.#view = { start: this.#view.start + dt, end: this.#view.end + dt };
    }
    this.#settingZoom = true;
    this.#chart.setOption({
      xAxis: { max: this.#now },
      dataZoom: [{ startValue: this.#view.start, endValue: this.#view.end }],
    });
    this.#settingZoom = false;
  }

  #report(kind: TimeSeriesStats["kind"], res: TimeSeriesResponse, rtt: number) {
    let returned = 0;
    let sourcePoints = 0;
    for (const s of res.series) {
      returned += s.t.length;
      sourcePoints += s.sourcePoints;
    }
    this.#options.onStats?.({
      kind,
      method: res.method,
      returned,
      sourcePoints,
      serverMs: res.serverMs,
      roundTripMs: rtt,
      payloadBytes: JSON.stringify(res).length,
      bucketMs: res.bucketMs,
      spanMs: this.#view.end - this.#view.start,
      windowRequests: this.#windowRequests,
    });
  }

  /** Show the last `spanMs` (at most everything) up to now and follow the live edge. */
  showLatest(spanMs: number) {
    this.#following = true;
    this.#view = {
      start: Math.max(this.#first, this.#now - spanMs),
      end: this.#now,
    };
    this.#settingZoom = true;
    this.#chart.setOption({
      dataZoom: [{ startValue: this.#view.start, endValue: this.#view.end }],
    });
    this.#settingZoom = false;
    this.#maybeRequest();
  }

  resize() {
    this.#chart.resize();
    if (this.#loaded) this.#maybeRequest();
  }

  dispose() {
    this.#disposed = true;
    clearTimeout(this.#debounce);
    clearInterval(this.#liveTimer);
    this.#chart.dispose();
  }
}
