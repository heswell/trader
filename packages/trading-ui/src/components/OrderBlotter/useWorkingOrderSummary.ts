import { useOptionalAuthenticatedUser } from "@vuu-ui/core";
import { useMemo } from "react";
import { useDataSourceRows } from "../../data/useDataSourceRows";
import { useTradingDataSource } from "../../data/useTradingDataSource";
import { filterString } from "../../utils/filters";
import { WORKING_STATUSES } from "../../utils/orderStatus";

export interface WorkingOrderSummary {
  /** Working parent orders the server's cancelAll would cancel. */
  count: number;
  /** Per-RIC counts, most orders first, then by RIC. */
  byRic: readonly { ric: string; count: number }[];
  loaded: boolean;
}

const MAX_ROWS = 2_000;

/** The filter cancelAll applies server side: live orders of this trader. */
export const workingOrderSummaryFilter = (trader?: string) => {
  const statuses = `status in [${WORKING_STATUSES.map((s) => `"${s}"`).join(", ")}]`;
  return trader ? `${statuses} and trader = ${filterString(trader)}` : statuses;
};

/**
 * What "Cancel all" would cancel: the current user's working parent orders
 * (every instrument and status tab, not only the blotter's rows), counted
 * per RIC. Informative only - the server decides when the request lands.
 */
export const useWorkingOrderSummary = (
  trader?: string,
): WorkingOrderSummary => {
  const user = useOptionalAuthenticatedUser();
  const filter = workingOrderSummaryFilter(trader ?? user?.userName);
  const dataSource = useTradingDataSource("parentOrders", {
    columns: ["orderId", "ric", "status", "trader"],
    filterSpec: { filter },
  });
  const { rows, size, loaded } = useDataSourceRows(dataSource, {
    rowCount: MAX_ROWS,
  });
  const byRic = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of rows) {
      const ric = String(row.ric);
      counts.set(ric, (counts.get(ric) ?? 0) + 1);
    }
    return [...counts]
      .map(([ric, count]) => ({ ric, count }))
      .sort((a, b) => b.count - a.count || a.ric.localeCompare(b.ric));
  }, [rows]);
  return { count: Math.max(size, rows.length), byRic, loaded };
};
