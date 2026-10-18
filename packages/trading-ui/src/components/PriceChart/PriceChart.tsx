import {
  CandlestickChart,
  type CandlestickOverlay,
  type MarkLineDef,
} from "@vuu-ui/vuu-chart";
import { ToggleButton, ToggleButtonGroup } from "@salt-ds/core";
import cx from "clsx";
import {
  forwardRef,
  type HTMLAttributes,
  type SyntheticEvent,
  useMemo,
  useState,
} from "react";
import { useChartDataSource } from "../../data/useChartDataSource";
import { useFollowedInstrument } from "../../hooks/useMarketData";
import {
  type LinkGroupProps,
  useComponentLinkGroup,
} from "../../instrument-context/useComponentLinkGroup";
import { filterString } from "../../utils/filters";
import {
  ChartFrame,
  chartFrameClass,
  disableSeriesAnimation,
} from "../ChartFrame/ChartFrame";
import { LinkGroupSelector } from "../LinkGroupSelector";

const classBase = "tradingPriceChart";

/** Bar intervals published by the exchange (`exchangeSim.barIntervals`). */
export const PRICE_CHART_INTERVALS = ["1s", "1m", "5m"] as const;

export type PriceChartInterval = string;

const BAR_COLUMNS = [
  "id",
  "ric",
  "interval",
  "start",
  "open",
  "high",
  "low",
  "close",
  "volume",
  "vwap",
  "trades",
];
const FILL_COLUMNS = [
  "execId",
  "account",
  "ric",
  "side",
  "price",
  "quantity",
  "timestamp",
];
const CANDLE_MARK_LINES: MarkLineDef[] = [
  { value: "last", label: "Last", lineType: "dashed" },
];
const SIDE_COLORS = { colors: { BUY: "up", SELL: "down" } } as const;

export interface PriceChartProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children">,
    LinkGroupProps {
  /** Instrument to chart; defaults to the followed (linked) instrument. */
  ric?: string;
  /** Bar interval (controlled). */
  interval?: PriceChartInterval;
  /** Initial bar interval when uncontrolled. Default "1m". */
  defaultInterval?: PriceChartInterval;
  /** Intervals offered by the selector. Default 1s / 1m / 5m. */
  intervals?: readonly PriceChartInterval[];
  /** The user picked another interval. */
  onIntervalChange?: (interval: PriceChartInterval) => void;
  /** Overlay the user's fills as BUY / SELL markers. Default true. */
  showFills?: boolean;
  /** Restrict the fill markers to one account (default: all visible). */
  account?: string;
  /** Overlay the per-bar VWAP line. Default true. */
  showVwap?: boolean;
  /** Show the volume pane. Default true. */
  showVolume?: boolean;
  /** Bars (and fills) read per DataSource. Default 500. */
  maxRows?: number;
}

/**
 * Candlestick price chart (EXCHANGE `bars`) for the followed instrument: an
 * interval selector, volume pane, per-bar VWAP line, the user's own fills
 * (OMS `fills`) as BUY / SELL markers with an average-fill mark line, and a
 * last-price mark line. Follows the link group like MarketDepth and creates
 * its own server-filtered DataSources (one per series) whenever the
 * instrument or interval changes.
 */
export const PriceChart = forwardRef<HTMLDivElement, PriceChartProps>(
  function PriceChart(
    {
      account,
      className,
      defaultInterval = "1m",
      defaultLinkGroup,
      interval: intervalProp,
      intervals = PRICE_CHART_INTERVALS,
      linkGroup: linkGroupProp,
      maxRows = 500,
      onIntervalChange,
      onLinkGroupChange,
      ric: ricProp,
      showFills = true,
      showLinkGroupSelector = false,
      showVolume = true,
      showVwap = true,
      ...htmlAttributes
    },
    ref,
  ) {
    const { linkGroup, channel, setLinkGroup } = useComponentLinkGroup({
      defaultLinkGroup,
      linkGroup: linkGroupProp,
      onLinkGroupChange,
      persistKey: htmlAttributes.id
        ? `PriceChart:${htmlAttributes.id}`
        : "PriceChart",
    });
    const { ric } = useFollowedInstrument(ricProp, { linkGroup: channel });
    const [intervalState, setIntervalState] = useState(defaultInterval);
    const interval = intervalProp ?? intervalState;
    const changeInterval = (value: PriceChartInterval) => {
      setIntervalState(value);
      onIntervalChange?.(value);
    };

    const bars = useChartDataSource("bars", {
      columns: BAR_COLUMNS,
      disabled: !ric,
      filter: ric
        ? `ric = ${filterString(ric)} and interval = ${filterString(interval)}`
        : undefined,
      sort: { column: "start" },
    });
    const fills = useChartDataSource("fills", {
      columns: FILL_COLUMNS,
      disabled: !ric || !showFills,
      filter: ric
        ? `ric = ${filterString(ric)}${account ? ` and account = ${filterString(account)}` : ""}`
        : undefined,
      sort: { column: "timestamp" },
    });

    const overlays = useMemo<CandlestickOverlay[]>(() => {
      const list: CandlestickOverlay[] = [];
      if (showVwap) {
        list.push({
          type: "line",
          columnName: "vwap",
          name: "VWAP",
          color: "palette-1",
        });
      }
      if (fills) {
        list.push({
          type: "scatter",
          id: "fills",
          columnName: "price",
          name: "Fills",
          dataSource: fills,
          timeColumnName: "timestamp",
          colorBy: { columnName: "side", ...SIDE_COLORS },
          symbol: "diamond",
          symbolSize: 10,
          markLines: [
            {
              value: { weightedAverage: "quantity" },
              label: "Avg fill",
              // clear of the "Last" label (trader upstream issue 97)
              labelPosition: "insideStartTop",
              color: "palette-7",
              lineType: "dotted",
            },
          ],
        });
      }
      return list;
    }, [fills, showVwap]);

    const toolbar = (
      <>
        {showLinkGroupSelector ? (
          <LinkGroupSelector value={linkGroup} onChange={setLinkGroup} />
        ) : null}
        <span className={`${chartFrameClass}-title`}>{ric ?? "Chart"}</span>
        <span className={`${chartFrameClass}-spacer`} />
        <ToggleButtonGroup
          aria-label="Bar interval"
          value={interval}
          onChange={(e: SyntheticEvent<HTMLButtonElement>) =>
            changeInterval(e.currentTarget.value)
          }
        >
          {intervals.map((value) => (
            <ToggleButton key={value} value={value}>
              {value}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
      </>
    );

    return (
      <ChartFrame
        {...htmlAttributes}
        className={cx(classBase, className)}
        data-interval={interval}
        data-link-group={linkGroup}
        message={bars ? undefined : "Select an instrument"}
        ref={ref}
        toolbar={toolbar}
      >
        {bars ? (
          <CandlestickChart
            echartsOptions={disableSeriesAnimation}
            aria-label={`Price chart ${ric} ${interval}`}
            dataZoom="inside"
            dataSource={bars}
            markLines={CANDLE_MARK_LINES}
            maxRows={maxRows}
            overlays={overlays}
            timeColumnName="start"
            volumeColumnName={showVolume ? "volume" : undefined}
          />
        ) : null}
      </ChartFrame>
    );
  },
);
