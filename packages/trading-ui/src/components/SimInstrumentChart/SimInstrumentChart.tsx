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

const classBase = "tradingSimInstrumentChart";

const X_AXIS = { columnName: "time", type: "time" } as const;

const PRICE_COLUMNS = [
  "id",
  "ric",
  "time",
  "fair",
  "walk",
  "mid",
  "bid",
  "ask",
];
const PRICE_AXES = [{ name: "Price", scale: true }];
const PRICE_SERIES: CartesianSeries[] = [
  {
    type: "line",
    columnName: "bid",
    name: "Bid",
    step: "end",
    color: "palette-3",
  },
  {
    type: "line",
    columnName: "ask",
    name: "Ask",
    step: "end",
    color: "palette-4",
  },
  { type: "line", columnName: "mid", name: "Mid", color: "palette-2" },
  { type: "line", columnName: "walk", name: "Walk", color: "palette-5" },
  { type: "line", columnName: "fair", name: "Fair", color: "palette-1" },
];

/** Signed aggressive volume per owner group, stacked. */
export const SIM_FLOW_GROUPS = [
  { column: "mmNet", name: "Market makers" },
  { column: "takerNet", name: "Takers" },
  { column: "omsNet", name: "OMS" },
  { column: "botNet", name: "Other bots" },
] as const;

const FLOW_COLUMNS = [
  "id",
  "ric",
  "time",
  ...SIM_FLOW_GROUPS.map((g) => g.column),
];
const FLOW_AXES = [{ name: "Net bought" }];
const FLOW_SERIES: CartesianSeries[] = SIM_FLOW_GROUPS.map((group, i) => ({
  type: "bar",
  columnName: group.column,
  name: group.name,
  stack: "flow",
  color: `palette-${i + 1}`,
}));

export interface SimInstrumentChartProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children">,
    LinkGroupProps {
  /** Instrument to chart; defaults to the followed (linked) instrument. */
  ric?: string;
}

/**
 * The simulator's view of one instrument from `simSamples` (sim-admin only):
 * hidden fair value, the walk under it and the quotes, with signed
 * aggressive volume by owner group (market makers, takers, OMS, other bots)
 * on a second chart sharing the time axis. The gap between fair and walk is
 * transient impact.
 */
export const SimInstrumentChart = forwardRef<
  HTMLDivElement,
  SimInstrumentChartProps
>(function SimInstrumentChart(
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
      ? `SimInstrumentChart:${htmlAttributes.id}`
      : "SimInstrumentChart",
  });
  const { ric } = useFollowedInstrument(ricProp, { linkGroup: channel });
  const filter = ric ? `ric = ${filterString(ric)}` : undefined;
  const prices = useChartDataSource("simSamples", {
    columns: PRICE_COLUMNS,
    disabled: !ric,
    filter,
    sort: { column: "time" },
  });
  const flow = useChartDataSource("simSamples", {
    columns: FLOW_COLUMNS,
    disabled: !ric,
    filter,
    sort: { column: "time" },
  });
  return (
    <ChartFrame
      {...htmlAttributes}
      className={cx(classBase, className)}
      data-link-group={linkGroup}
      message={prices && flow ? undefined : "Select an instrument"}
      ref={ref}
      toolbar={
        <>
          {showLinkGroupSelector ? (
            <LinkGroupSelector value={linkGroup} onChange={setLinkGroup} />
          ) : null}
          <span className={`${chartFrameClass}-title`}>
            {ric ? `${ric} fair value and flow` : "Fair value and flow"}
          </span>
        </>
      }
    >
      {prices && flow ? (
        <div
          style={{ display: "flex", flexDirection: "column", height: "100%" }}
        >
          <div style={{ flex: "2 1 0", minHeight: 0 }}>
            <CartesianChart
              echartsOptions={disableSeriesAnimation}
              aria-label={`Fair value, walk and quotes ${ric}`}
              dataSource={prices}
              series={PRICE_SERIES}
              xAxis={X_AXIS}
              yAxes={PRICE_AXES}
            />
          </div>
          <div style={{ flex: "1 1 0", minHeight: 0 }}>
            <CartesianChart
              echartsOptions={disableSeriesAnimation}
              aria-label={`Aggressive volume by owner ${ric}`}
              dataSource={flow}
              series={FLOW_SERIES}
              xAxis={X_AXIS}
              yAxes={FLOW_AXES}
            />
          </div>
        </div>
      ) : null}
    </ChartFrame>
  );
});
