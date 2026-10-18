import { CartesianChart, type CartesianSeries } from "@vuu-ui/vuu-chart";
import cx from "clsx";
import { forwardRef, type HTMLAttributes } from "react";
import { useChartDataSource } from "../../data/useChartDataSource";
import { filterString } from "../../utils/filters";
import { AccountSelector, useSelectedAccount } from "../AccountSelector";
import {
  ChartFrame,
  chartFrameClass,
  disableSeriesAnimation,
} from "../ChartFrame/ChartFrame";

const classBase = "tradingPnlHistoryChart";

const PNL_COLUMNS = [
  "id",
  "account",
  "time",
  "realizedPnl",
  "unrealizedPnl",
  "totalPnl",
];
const X_AXIS = { columnName: "time", type: "time" } as const;
const Y_AXES = [{ name: "USD" }];
const SERIES: CartesianSeries[] = [
  {
    type: "line",
    columnName: "totalPnl",
    name: "Total",
    color: "palette-1",
    markLines: [{ value: "last", label: "Total", lineType: "dashed" }],
  },
  {
    type: "line",
    columnName: "realizedPnl",
    name: "Realized",
    color: "palette-4",
  },
  {
    type: "line",
    columnName: "unrealizedPnl",
    name: "Unrealized",
    color: "palette-2",
  },
];

export interface PnlHistoryChartProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children" | "onChange"> {
  /**
   * Account to chart (controlled). Default: the user's selected account
   * (see useSelectedAccount), switchable with the toolbar selector.
   */
  account?: string;
  /** Show the account selector. Default true (ignored when `account` is set). */
  showAccountSelector?: boolean;
}

/**
 * Account P&L over time in USD - total, realized and unrealized - from the
 * OMS `accountPnlHistory` table (periodic samples, rolling window). Only
 * accounts the user is entitled to see are offered (the OMS filters the
 * table by account).
 */
export const PnlHistoryChart = forwardRef<HTMLDivElement, PnlHistoryChartProps>(
  function PnlHistoryChart(
    {
      account: accountProp,
      className,
      showAccountSelector = true,
      ...htmlAttributes
    },
    ref,
  ) {
    const [selected, setSelected, accounts] = useSelectedAccount();
    const account = accountProp ?? selected;
    const history = useChartDataSource("accountPnlHistory", {
      columns: PNL_COLUMNS,
      disabled: !account,
      filter: account ? `account = ${filterString(account)}` : undefined,
      sort: { column: "time" },
    });
    return (
      <ChartFrame
        {...htmlAttributes}
        className={cx(classBase, className)}
        data-account={account}
        message={history ? undefined : "No account"}
        ref={ref}
        toolbar={
          <>
            <span className={`${chartFrameClass}-title`}>P&amp;L (USD)</span>
            {showAccountSelector && accountProp === undefined ? (
              <AccountSelector
                accounts={accounts}
                onChange={setSelected}
                value={account}
              />
            ) : (
              <span>{account}</span>
            )}
          </>
        }
      >
        {history ? (
          <CartesianChart
            echartsOptions={disableSeriesAnimation}
            aria-label={`P&L history ${account}`}
            dataSource={history}
            series={SERIES}
            xAxis={X_AXIS}
            yAxes={Y_AXES}
          />
        ) : null}
      </ChartFrame>
    );
  },
);
