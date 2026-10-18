import { CartesianChart, type CartesianSeries } from "@vuu-ui/vuu-chart";
import cx from "clsx";
import { forwardRef, type HTMLAttributes } from "react";
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

const classBase = "tradingSpreadChart";

const SAMPLE_COLUMNS = ["id", "ric", "time", "spreadBps", "imbalance"];
const X_AXIS = { columnName: "time", type: "time" } as const;
const Y_AXES = [
  { name: "Spread (bps)", min: 0 },
  { name: "Imbalance", min: -1, max: 1 },
];
const SERIES: CartesianSeries[] = [
  {
    type: "line",
    columnName: "spreadBps",
    name: "Spread (bps)",
    step: "end",
    color: "palette-1",
    markLines: [{ value: "average", label: "Avg", lineType: "dotted" }],
  },
  {
    type: "area",
    columnName: "imbalance",
    name: "Imbalance",
    yAxisIndex: 1,
    color: "palette-4",
    areaOpacity: 0.2,
  },
];

export interface SpreadChartProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children">,
    LinkGroupProps {
  /** Instrument to chart; defaults to the followed (linked) instrument. */
  ric?: string;
}

/**
 * Bid/ask spread (bps) and top-5 book imbalance over time for the followed
 * instrument, from the EXCHANGE `bookSamples` table (one sample per second,
 * rolling window). Imbalance runs from -1 (all asks) to +1 (all bids) on the
 * right-hand axis.
 */
export const SpreadChart = forwardRef<HTMLDivElement, SpreadChartProps>(
  function SpreadChart(
    {
      className,
      defaultLinkGroup,
      linkGroup: linkGroupProp,
      onLinkGroupChange,
      ric: ricProp,
      showLinkGroupSelector = false,
      ...htmlAttributes
    },
    ref,
  ) {
    const { linkGroup, channel, setLinkGroup } = useComponentLinkGroup({
      defaultLinkGroup,
      linkGroup: linkGroupProp,
      onLinkGroupChange,
      persistKey: htmlAttributes.id
        ? `SpreadChart:${htmlAttributes.id}`
        : "SpreadChart",
    });
    const { ric } = useFollowedInstrument(ricProp, { linkGroup: channel });
    const samples = useChartDataSource("bookSamples", {
      columns: SAMPLE_COLUMNS,
      disabled: !ric,
      filter: ric ? `ric = ${filterString(ric)}` : undefined,
      sort: { column: "time" },
    });
    return (
      <ChartFrame
        {...htmlAttributes}
        className={cx(classBase, className)}
        data-link-group={linkGroup}
        message={samples ? undefined : "Select an instrument"}
        ref={ref}
        toolbar={
          <>
            {showLinkGroupSelector ? (
              <LinkGroupSelector value={linkGroup} onChange={setLinkGroup} />
            ) : null}
            <span className={`${chartFrameClass}-title`}>
              {ric ? `${ric} spread / imbalance` : "Spread / imbalance"}
            </span>
          </>
        }
      >
        {samples ? (
          <CartesianChart
            echartsOptions={disableSeriesAnimation}
            aria-label={`Spread and imbalance ${ric}`}
            dataSource={samples}
            series={SERIES}
            xAxis={X_AXIS}
            yAxes={Y_AXES}
          />
        ) : null}
      </ChartFrame>
    );
  },
);
