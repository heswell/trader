import { RpcName, type TimeSeriesField } from "@heswell/trading-schemas";
import { useComponentCssInjection } from "@salt-ds/styles";
import { useWindow } from "@salt-ds/window";
import { Button } from "@salt-ds/core";
import cx from "clsx";
import {
  forwardRef,
  type HTMLAttributes,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTradingConnectionStatus } from "../../connection/useTradingConnectionStatus";
import { sendTradingRpc, TradingRpcError } from "../../data/tradingRpc";
import { useTradingRows } from "../../data/useTradingRows";
import { useFollowedInstrument } from "../../hooks/useMarketData";
import {
  type LinkGroupProps,
  useComponentLinkGroup,
} from "../../instrument-context/useComponentLinkGroup";
import { filterString } from "../../utils/filters";
import { ChartFrame, chartFrameClass } from "../ChartFrame/ChartFrame";
import { LinkGroupSelector } from "../LinkGroupSelector";
import timeSeriesChartCss from "./TimeSeriesChart.css";
import {
  TimeSeriesController,
  type TimeSeriesStats,
} from "./TimeSeriesController";
import { BUCKET_COLUMNS, type BucketRow } from "./timeSeriesWindow";

const classBase = "tradingTimeSeriesChart";

/** Bucket rows a subscription can hold: (1 + 2 × overscan) × width × fields. */
const MAX_ROWS = 20_000;

let nextSubId = 0;
const newSubId = () =>
  `ts-${Date.now().toString(36)}-${(nextSubId++).toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;

const DAY_MS = 86_400_000;
const YEAR_MS = 365.25 * DAY_MS;

/** Range buttons: the last span up to now (clamped to the history held). */
const SPANS = [
  ["1h", 3_600_000],
  ["1d", DAY_MS],
  ["1w", 7 * DAY_MS],
  ["1m", YEAR_MS / 12],
  ["6m", YEAR_MS / 2],
  ["1y", YEAR_MS],
  ["2y", 2 * YEAR_MS],
  ["5y", 5 * YEAR_MS],
] as const;

const DEFAULT_FIELDS: readonly TimeSeriesField[] = ["mid"];

const formatSpan = (ms: number) =>
  ms >= YEAR_MS
    ? `${(ms / YEAR_MS).toFixed(1)}y`
    : ms >= DAY_MS
      ? `${(ms / DAY_MS).toFixed(1)}d`
      : ms >= 3_600_000
        ? `${(ms / 3_600_000).toFixed(1)}h`
        : ms >= 60_000
          ? `${Math.round(ms / 60_000)}min`
          : `${Math.round(ms / 1000)}s`;

/** One line of numbers: the last window change and the live stream. */
export const formatTimeSeriesStats = (s: TimeSeriesStats) =>
  `${s.buckets.toLocaleString()} buckets of ${s.bucketMs.toLocaleString()} ms · last change +${s.upserts.toLocaleString()} / −${s.removed.toLocaleString()} rows · server ${s.serverMs.toFixed(2)} ms · rtt ${s.roundTripMs.toFixed(0)} ms · span ${formatSpan(s.spanMs)} · ${s.windowRequests} windows · ${s.rowUpdates} row updates${s.following ? " · following" : ""}`;

export interface TimeSeriesChartProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children">,
    LinkGroupProps {
  /** Instrument to chart; defaults to the followed (linked) instrument. */
  ric?: string;
  /** Fields of the EXCHANGE time-series store (first on the left axis, second on the right). */
  fields?: readonly TimeSeriesField[];
  /** Initial visible span ending now (ms), default an hour. */
  defaultSpanMs?: number;
  /** Show the subscription's numbers (buckets, rows sent, server time) under the toolbar (default true). */
  showStats?: boolean;
  /** Called with the numbers of every answered request. */
  onStats?: (stats: TimeSeriesStats) => void;
}

/**
 * Line chart over a large time series (the EXCHANGE time-series store: days
 * of 1 s mid / spread per instrument) that the server downsamples for the
 * visible window and the chart's pixel width (timeSeries RPC). Wheel zooms,
 * drag pans; a debounced request reloads the window when the resolution or
 * the loaded range (with overscan) no longer fits. At the live edge the
 * chart follows now, refreshing only its last bucket.
 */
export const TimeSeriesChart = forwardRef<HTMLDivElement, TimeSeriesChartProps>(
  function TimeSeriesChart(
    {
      className,
      defaultLinkGroup,
      defaultSpanMs = 3_600_000,
      fields = DEFAULT_FIELDS,
      linkGroup: linkGroupProp,
      onLinkGroupChange,
      onStats,
      ric: ricProp,
      showLinkGroupSelector = false,
      showStats = true,
      ...htmlAttributes
    },
    ref,
  ) {
    const targetWindow = useWindow();
    useComponentCssInjection({
      testId: "trading-time-series-chart",
      css: timeSeriesChartCss,
      window: targetWindow,
    });
    const { linkGroup, channel, setLinkGroup } = useComponentLinkGroup({
      defaultLinkGroup,
      linkGroup: linkGroupProp,
      onLinkGroupChange,
      persistKey: htmlAttributes.id
        ? `TimeSeriesChart:${htmlAttributes.id}`
        : "TimeSeriesChart",
    });
    const { ric } = useFollowedInstrument(ricProp, { linkGroup: channel });
    const fieldKey = fields.join(",");
    // One subscription per instrument and fields: its buckets are the rows
    // of timeSeriesBuckets with this subId, and the RPCs moving its window
    // go through the same viewport.
    // biome-ignore lint/correctness/useExhaustiveDependencies: new id per ric / fields
    const subId = useMemo(() => newSubId(), [ric, fieldKey]);
    const { dataSource, rows } = useTradingRows("timeSeriesBuckets", {
      columns: [...BUCKET_COLUMNS],
      filter: `subId = ${filterString(subId)}`,
      rowCount: MAX_ROWS,
    });
    const { state: connectionState } = useTradingConnectionStatus();
    const plotRef = useRef<HTMLDivElement>(null);
    const controllerRef = useRef<TimeSeriesController>(null);
    const [stats, setStats] = useState<TimeSeriesStats>();
    const [error, setError] = useState<string>();
    const onStatsRef = useRef(onStats);
    onStatsRef.current = onStats;
    useEffect(() => {
      const element = plotRef.current;
      if (!element || !ric) return;
      setError(undefined);
      setStats(undefined);
      const controller = new TimeSeriesController(element, {
        fields: fieldKey.split(","),
        spanMs: defaultSpanMs,
        send: (window) =>
          sendTradingRpc(
            dataSource,
            RpcName.SetTimeSeriesWindow,
            { subId, ric, fields: fieldKey, ...window },
            { connectionState },
          ),
        onStats: (s) => {
          setStats(s);
          onStatsRef.current?.(s);
        },
        onError: (err) =>
          setError(
            err instanceof TradingRpcError
              ? err.text || err.message
              : String(err),
          ),
      });
      controllerRef.current = controller;
      const observer = new ResizeObserver(() => controller.resize());
      observer.observe(element);
      return () => {
        observer.disconnect();
        controller.dispose();
        controllerRef.current = null;
        sendTradingRpc(dataSource, RpcName.CloseTimeSeries, { subId }).catch(
          () => undefined,
        );
      };
    }, [connectionState, dataSource, defaultSpanMs, fieldKey, ric, subId]);

    useEffect(() => {
      controllerRef.current?.setRows(rows as unknown as BucketRow[]);
    }, [rows]);

    const toolbar = (
      <>
        {showLinkGroupSelector ? (
          <LinkGroupSelector value={linkGroup} onChange={setLinkGroup} />
        ) : null}
        <span className={`${chartFrameClass}-title`}>
          {ric ? `${ric} ${fields.join(" / ")}` : "Time series"}
        </span>
        <span className={`${chartFrameClass}-spacer`} />
        {SPANS.map(([label, span]) => (
          <Button
            key={label}
            appearance="transparent"
            onClick={() => controllerRef.current?.showLatest(span)}
          >
            {label}
          </Button>
        ))}
      </>
    );

    return (
      <ChartFrame
        {...htmlAttributes}
        className={cx(classBase, className)}
        data-link-group={linkGroup}
        message={ric ? undefined : "Select an instrument"}
        ref={ref}
        toolbar={toolbar}
      >
        {showStats ? (
          <output
            className={cx(`${classBase}-stats`, {
              [`${classBase}-error`]: error,
            })}
            style={{ position: "absolute", left: 8, top: 2, zIndex: 1 }}
          >
            {error ?? (stats ? formatTimeSeriesStats(stats) : "loading…")}
          </output>
        ) : null}
        <div className={`${classBase}-plot vuuChart`} ref={plotRef} />
      </ChartFrame>
    );
  },
);
