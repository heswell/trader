import { CartesianChart, type CartesianSeries } from "@vuu-ui/vuu-chart";
import cx from "clsx";
import { forwardRef, type HTMLAttributes } from "react";
import { useChartDataSource } from "../../data/useChartDataSource";
import { filterString } from "../../utils/filters";
import {
  ChartFrame,
  chartFrameClass,
  disableSeriesAnimation,
} from "../ChartFrame/ChartFrame";

const classBase = "tradingSlippageChart";

const ORDER_COLUMNS = [
  "orderId",
  "account",
  "ric",
  "side",
  "created",
  "cumQty",
  "avgPx",
  "arrivalPrice",
  "slippageBps",
];
const X_AXIS = { columnName: "created", type: "time" } as const;
const Y_AXES = [{ name: "Slippage (bps)" }];
const SERIES: CartesianSeries[] = [
  {
    type: "scatter",
    columnName: "slippageBps",
    name: "Slippage (bps)",
    colorBy: { columnName: "side", colors: { BUY: "up", SELL: "down" } },
    symbolSize: 8,
    markLines: [
      { value: 0, label: "Arrival", lineType: "solid" },
      { value: "average", label: "Avg", lineType: "dotted" },
    ],
  },
];

export interface SlippageChartProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  /** Restrict to one account (default: every account the user can see). */
  account?: string;
  /** Restrict to one instrument. */
  ric?: string;
  /** Parent orders read (newest first). Default 1000. */
  maxRows?: number;
}

/**
 * Execution quality: slippage versus arrival price (bps, positive = worse)
 * of each (partly) filled parent order over time, coloured by side, from the
 * OMS `parentOrders` table, with zero (arrival) and average mark lines.
 */
export const SlippageChart = forwardRef<HTMLDivElement, SlippageChartProps>(
  function SlippageChart(
    { account, className, maxRows = 1000, ric, ...htmlAttributes },
    ref,
  ) {
    const filter = [
      "cumQty > 0",
      account ? `account = ${filterString(account)}` : undefined,
      ric ? `ric = ${filterString(ric)}` : undefined,
    ]
      .filter(Boolean)
      .join(" and ");
    const orders = useChartDataSource("parentOrders", {
      columns: ORDER_COLUMNS,
      filter,
      sort: { column: "created" },
    });
    return (
      <ChartFrame
        {...htmlAttributes}
        className={cx(classBase, className)}
        ref={ref}
        toolbar={
          <span className={`${chartFrameClass}-title`}>
            Slippage vs arrival{ric ? ` · ${ric}` : ""}
          </span>
        }
      >
        {orders ? (
          <CartesianChart
            echartsOptions={disableSeriesAnimation}
            aria-label="Slippage versus arrival price"
            crosshair={false}
            dataSource={orders}
            maxRows={maxRows}
            series={SERIES}
            xAxis={X_AXIS}
            yAxes={Y_AXES}
          />
        ) : null}
      </ChartFrame>
    );
  },
);
