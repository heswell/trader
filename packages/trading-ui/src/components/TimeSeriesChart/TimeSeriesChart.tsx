import {
  DOWNSAMPLE_METHODS,
  type DownsampleMethod,
  RpcName,
  type TimeSeriesField,
} from "@heswell/trading-schemas";
import { useComponentCssInjection } from "@salt-ds/styles";
import { useWindow } from "@salt-ds/window";
import { Button, ToggleButton, ToggleButtonGroup } from "@salt-ds/core";
import cx from "clsx";
import {
  forwardRef,
  type HTMLAttributes,
  type SyntheticEvent,
  useEffect,
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

const classBase = "tradingTimeSeriesChart";

const METHOD_LABELS: Record<DownsampleMethod, string> = {
  m4: "M4",
  minmaxlttb: "MinMaxLTTB",
  lttb: "LTTB",
  raw: "Stride",
};

const SPANS = [
  ["1h", 3_600_000],
  ["1d", 86_400_000],
  ["All", Number.MAX_SAFE_INTEGER],
] as const;

const DEFAULT_FIELDS: readonly TimeSeriesField[] = ["mid"];

const formatSpan = (ms: number) =>
  ms >= 86_400_000
    ? `${(ms / 86_400_000).toFixed(1)}d`
    : ms >= 3_600_000
      ? `${(ms / 3_600_000).toFixed(1)}h`
      : `${Math.round(ms / 60_000)}m`;

/** One line of numbers: the last window request, and the last live tail. */
export const formatTimeSeriesStats = (
  window: TimeSeriesStats,
  tail?: TimeSeriesStats,
) =>
  `${METHOD_LABELS[window.method]} ${window.returned.toLocaleString()} of ${window.sourcePoints.toLocaleString()} pts · server ${window.serverMs.toFixed(2)} ms · rtt ${window.roundTripMs.toFixed(0)} ms · ${(window.payloadBytes / 1024).toFixed(1)} KB · bucket ${window.bucketMs.toLocaleString()} ms · span ${formatSpan(window.spanMs)} · ${window.windowRequests} req${
    tail
      ? ` | live ${tail.returned} pts ${(tail.payloadBytes / 1024).toFixed(1)} KB ${tail.serverMs.toFixed(2)} ms`
      : ""
  }`;

export interface TimeSeriesChartProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children">,
    LinkGroupProps {
  /** Instrument to chart; defaults to the followed (linked) instrument. */
  ric?: string;
  /** Fields of the EXCHANGE time-series store (first on the left axis, second on the right). */
  fields?: readonly TimeSeriesField[];
  /** Downsampling method (controlled), or `defaultMethod` (uncontrolled, "m4"). */
  method?: DownsampleMethod;
  defaultMethod?: DownsampleMethod;
  onMethodChange?: (method: DownsampleMethod) => void;
  /** Show the method selector in the toolbar (default true). */
  showMethodSelector?: boolean;
  /** Initial visible span ending now (ms), default an hour. */
  defaultSpanMs?: number;
  /** Show request numbers (points, server time, payload) under the toolbar (default true). */
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
      defaultMethod = "m4",
      defaultSpanMs = 3_600_000,
      fields = DEFAULT_FIELDS,
      linkGroup: linkGroupProp,
      method: methodProp,
      onLinkGroupChange,
      onMethodChange,
      onStats,
      ric: ricProp,
      showLinkGroupSelector = false,
      showMethodSelector = true,
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
    const [methodState, setMethodState] = useState(defaultMethod);
    const method = methodProp ?? methodState;
    const changeMethod = (value: DownsampleMethod) => {
      setMethodState(value);
      onMethodChange?.(value);
    };
    // Any subscribed EXCHANGE viewport carries the RPC.
    const { dataSource } = useTradingRows("instruments", {
      columns: ["ric"],
      filter: ric ? `ric = ${filterString(ric)}` : 'ric = ""',
      rowCount: 1,
    });
    const { state: connectionState } = useTradingConnectionStatus();
    const plotRef = useRef<HTMLDivElement>(null);
    const controllerRef = useRef<TimeSeriesController>(null);
    const [stats, setStats] = useState<{
      window?: TimeSeriesStats;
      tail?: TimeSeriesStats;
    }>({});
    const [error, setError] = useState<string>();
    const onStatsRef = useRef(onStats);
    onStatsRef.current = onStats;
    const fieldKey = fields.join(",");

    useEffect(() => {
      const element = plotRef.current;
      if (!element || !ric) return;
      setError(undefined);
      setStats({});
      const controller = new TimeSeriesController(element, {
        ric,
        fields: fieldKey.split(","),
        method,
        spanMs: defaultSpanMs,
        send: (params) =>
          sendTradingRpc(dataSource, RpcName.TimeSeries, params, {
            connectionState,
          }),
        onStats: (s) => {
          setStats((prev) => ({ ...prev, [s.kind]: s }));
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
      };
    }, [connectionState, dataSource, defaultSpanMs, fieldKey, method, ric]);

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
        {showMethodSelector ? (
          <ToggleButtonGroup
            aria-label="Downsampling method"
            value={method}
            onChange={(e: SyntheticEvent<HTMLButtonElement>) =>
              changeMethod(e.currentTarget.value as DownsampleMethod)
            }
          >
            {DOWNSAMPLE_METHODS.map((value) => (
              <ToggleButton key={value} value={value}>
                {METHOD_LABELS[value]}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
        ) : null}
      </>
    );

    return (
      <ChartFrame
        {...htmlAttributes}
        className={cx(classBase, className)}
        data-link-group={linkGroup}
        data-method={method}
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
            {error ??
              (stats.window
                ? formatTimeSeriesStats(stats.window, stats.tail)
                : "loading…")}
          </output>
        ) : null}
        <div className={`${classBase}-plot vuuChart`} ref={plotRef} />
      </ChartFrame>
    );
  },
);
