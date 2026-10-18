import { DepthChart } from "@vuu-ui/vuu-chart";
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

const classBase = "tradingDepthChartView";

const DEPTH_COLUMNS = [
  "id",
  "ric",
  "side",
  "level",
  "price",
  "size",
  "cumSize",
];

export interface DepthChartViewProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children">,
    LinkGroupProps {
  /** Instrument to chart; defaults to the followed (linked) instrument. */
  ric?: string;
  /** Draw the mid-price line. Default true. */
  showMidPrice?: boolean;
  /** Show the toolbar (RIC and link group selector). Default true. */
  showToolbar?: boolean;
}

/**
 * Live stepped depth chart (EXCHANGE `depth`) for the followed instrument:
 * cumulative bid and ask size against price, with the mid price marked.
 * A chart view of the same data as MarketDepth; it follows the link group
 * and creates its own ric-filtered DataSource per instrument.
 */
export const DepthChartView = forwardRef<HTMLDivElement, DepthChartViewProps>(
  function DepthChartView(
    {
      className,
      defaultLinkGroup,
      linkGroup: linkGroupProp,
      onLinkGroupChange,
      ric: ricProp,
      showLinkGroupSelector = false,
      showMidPrice = true,
      showToolbar = true,
      ...htmlAttributes
    },
    ref,
  ) {
    const { linkGroup, channel, setLinkGroup } = useComponentLinkGroup({
      defaultLinkGroup,
      linkGroup: linkGroupProp,
      onLinkGroupChange,
      persistKey: htmlAttributes.id
        ? `DepthChartView:${htmlAttributes.id}`
        : "DepthChartView",
    });
    const { ric } = useFollowedInstrument(ricProp, { linkGroup: channel });
    const depth = useChartDataSource("depth", {
      columns: DEPTH_COLUMNS,
      disabled: !ric,
      filter: ric ? `ric = ${filterString(ric)}` : undefined,
    });
    const toolbar =
      showToolbar || showLinkGroupSelector ? (
        <>
          {showLinkGroupSelector ? (
            <LinkGroupSelector value={linkGroup} onChange={setLinkGroup} />
          ) : null}
          <span className={`${chartFrameClass}-title`}>{ric ?? "Depth"}</span>
        </>
      ) : undefined;
    return (
      <ChartFrame
        {...htmlAttributes}
        className={cx(classBase, className)}
        data-link-group={linkGroup}
        message={depth ? undefined : "Select an instrument"}
        ref={ref}
        toolbar={toolbar}
      >
        {depth ? (
          <DepthChart
            echartsOptions={disableSeriesAnimation}
            aria-label={`Depth chart ${ric}`}
            cumulativeSizeColumnName="cumSize"
            dataSource={depth}
            // a top legend collides with the mid-price label and a bottom one
            // with the price axis labels (trader upstream issue 96); bid /
            // ask are colour-coded and named in the tooltip
            legend="none"
            showMidPrice={showMidPrice}
          />
        ) : null}
      </ChartFrame>
    );
  },
);
