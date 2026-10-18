import { ToggleButton, ToggleButtonGroup } from "@salt-ds/core";
import { type ChartRow, TreemapChart } from "@vuu-ui/vuu-chart";
import type { ColumnMap } from "@vuu-ui/vuu-utils";
import cx from "clsx";
import {
  forwardRef,
  type HTMLAttributes,
  type SyntheticEvent,
  useState,
} from "react";
import { useChartDataSource } from "../../data/useChartDataSource";
import { filterString } from "../../utils/filters";
import { formatQuantity } from "../../utils/formatting";
import {
  ChartFrame,
  chartFrameClass,
  disableSeriesAnimation,
} from "../ChartFrame/ChartFrame";

const classBase = "tradingExposureTreemap";

/** What the tile areas measure (both in USD). */
export type ExposureMeasure = "exposure" | "pnl";

const VALUE_COLUMN: Record<ExposureMeasure, string> = {
  exposure: "marketValueUsd",
  pnl: "totalPnlUsd",
};
const POSITION_COLUMNS = [
  "id",
  "account",
  "ric",
  "sector",
  "quantity",
  "marketValueUsd",
  "totalPnlUsd",
];
const GROUP_BY = ["sector", "ric"];
const isOpen = (row: ChartRow, columnMap: ColumnMap) =>
  row[columnMap.quantity] !== 0;
const formatUsd = (value: number) =>
  `${value < 0 ? "-" : ""}$${formatQuantity(Math.abs(Math.round(value)), { compact: true })}`;

export interface ExposureTreemapProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  /** Restrict to one account (default: every account the user can see). */
  account?: string;
  /** Measure (controlled). */
  measure?: ExposureMeasure;
  /** Initial measure when uncontrolled. Default "exposure". */
  defaultMeasure?: ExposureMeasure;
  /** Show the Exposure / P&L toggle. Default true. */
  showMeasureSelector?: boolean;
}

/**
 * Position treemap grouped by sector then instrument, from the OMS
 * `positionPrices` join. Tile area is |USD market value| (exposure) or
 * |USD total P&L|; colour is the sign (long / profit = up, short / loss =
 * down). Flat positions are hidden. Positions are account-filtered by the
 * OMS, so users only see accounts they are entitled to.
 */
export const ExposureTreemap = forwardRef<HTMLDivElement, ExposureTreemapProps>(
  function ExposureTreemap(
    {
      account,
      className,
      defaultMeasure = "exposure",
      measure: measureProp,
      showMeasureSelector = true,
      ...htmlAttributes
    },
    ref,
  ) {
    const [measureState, setMeasure] = useState(defaultMeasure);
    const measure = measureProp ?? measureState;
    const positions = useChartDataSource("positionPrices", {
      columns: POSITION_COLUMNS,
      filter: account ? `account = ${filterString(account)}` : undefined,
    });
    return (
      <ChartFrame
        {...htmlAttributes}
        className={cx(classBase, className)}
        data-measure={measure}
        ref={ref}
        toolbar={
          <>
            <span className={`${chartFrameClass}-title`}>
              {measure === "pnl" ? "P&L by sector (USD)" : "Exposure (USD)"}
            </span>
            <span className={`${chartFrameClass}-spacer`} />
            {showMeasureSelector ? (
              <ToggleButtonGroup
                aria-label="Measure"
                value={measure}
                onChange={(e: SyntheticEvent<HTMLButtonElement>) =>
                  setMeasure(e.currentTarget.value as ExposureMeasure)
                }
              >
                <ToggleButton value="exposure">Exposure</ToggleButton>
                <ToggleButton value="pnl">P&amp;L</ToggleButton>
              </ToggleButtonGroup>
            ) : null}
          </>
        }
      >
        {positions ? (
          <TreemapChart
            echartsOptions={disableSeriesAnimation}
            aria-label={measure === "pnl" ? "P&L treemap" : "Exposure treemap"}
            colorMode="sign"
            dataSource={positions}
            formatValue={formatUsd}
            groupByColumnNames={GROUP_BY}
            valueColumnName={VALUE_COLUMN[measure]}
            where={isOpen}
          />
        ) : null}
      </ChartFrame>
    );
  },
);
