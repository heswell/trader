import { useMemo } from "react";
import { useDataSourceRows } from "../data/useDataSourceRows";
import { useTradingDataSource } from "../data/useTradingDataSource";
import { filterString } from "../utils/filters";
import { OWN_ORDER_STATUSES, type OwnOrder } from "./useOwnWorkingOrders";

const EMPTY: ReadonlySet<string> = new Set();

/**
 * Exchange order ids (OMS `childOrders.exchangeOrderId`) of the working
 * child orders of `orders`, so the user's orders can be picked out of the
 * anonymous L3 book (`bookOrders.orderId`).
 */
export const useOwnExchangeOrderIds = (
  ric: string | undefined,
  orders: readonly OwnOrder[],
  { enabled = true, maxOrders = 1_000 } = {},
): ReadonlySet<string> => {
  const dataSource = useTradingDataSource("childOrders", {
    columns: [
      "childOrderId",
      "parentOrderId",
      "exchangeOrderId",
      "ric",
      "status",
    ],
  });
  const active = enabled && !!ric && orders.length > 0;
  const { rows } = useDataSourceRows(dataSource, {
    enabled: active,
    filter: ric
      ? `ric = ${filterString(ric)} and status in [${OWN_ORDER_STATUSES.map(filterString).join(",")}]`
      : "",
    rowCount: maxOrders,
  });
  // a stable key, so the set (and the queues built from it) only change
  // when the ids do
  const parentKey = orders
    .map((o) => o.orderId)
    .sort()
    .join(",");
  const idKey = useMemo(() => {
    if (!active) return "";
    const parents = new Set(parentKey.split(","));
    const ids: string[] = [];
    for (const row of rows) {
      const id = row.exchangeOrderId;
      if (
        typeof id === "string" &&
        id &&
        row.ric === ric &&
        parents.has(String(row.parentOrderId))
      ) {
        ids.push(id);
      }
    }
    return ids.sort().join(",");
  }, [active, rows, ric, parentKey]);
  return useMemo(() => (idKey ? new Set(idKey.split(",")) : EMPTY), [idKey]);
};
