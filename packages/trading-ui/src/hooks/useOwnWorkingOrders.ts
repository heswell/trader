import {
  canCancel,
  OrdStatus,
  OrdType,
  type Side,
} from "@heswell/trading-schemas";
import type { DataSource } from "@vuu-ui/vuu-data-types";
import { useMemo } from "react";
import { useTradingDataSource } from "../data/useTradingDataSource";
import { priceKey } from "./useMarketData";
import { useDataSourceRows } from "../data/useDataSourceRows";
import { filterString } from "../utils/filters";

/**
 * A working (or pending) parent order of the current user resting on the
 * book at its limit: a LIMIT, or a STOP_LIMIT once its stop has triggered.
 */
export interface OwnOrder {
  orderId: string;
  clOrdId?: string;
  account: string;
  ric: string;
  side: Side;
  /** LIMIT or (triggered) STOP_LIMIT. */
  ordType?: OrdType;
  price: number;
  /** STOP_LIMIT: the stop it triggered at (0 for a LIMIT). */
  stopPrice?: number;
  quantity: number;
  leavesQty: number;
  cumQty: number;
  status: OrdStatus;
}

/** Own orders on one side at one price. */
export interface OwnOrdersAtPrice {
  side: Side;
  price: number;
  /** Sum of leavesQty. */
  quantity: number;
  orders: OwnOrder[];
}

/** Statuses shown as "own working": working plus in-flight. */
export const OWN_ORDER_STATUSES: readonly OrdStatus[] = [
  OrdStatus.PendingNew,
  OrdStatus.New,
  OrdStatus.PartiallyFilled,
  OrdStatus.Replaced,
  OrdStatus.PendingReplace,
  OrdStatus.PendingCancel,
];

export interface OwnWorkingOrders {
  orders: OwnOrder[];
  /** Keyed by `ownOrdersKey(side, price)`. */
  byPrice: Map<string, OwnOrdersAtPrice>;
  /**
   * The subscribed OMS (parentOrders) data source - send order RPCs
   * (createOrder, amendOrder, cancelOrder, cancelAll) through it.
   */
  dataSource: DataSource;
  loaded: boolean;
}

/**
 * Key of a price level (`side|price`) in the map returned by
 * useOwnWorkingOrders.
 */
export const ownOrdersKey = (side: Side | string, price: number) =>
  `${side}|${priceKey(price)}`;

export interface OwnWorkingOrdersOptions {
  /** Only this account's orders (default: every account the user can see). */
  account?: string;
  maxOrders?: number;
}

/** Order types that can rest on the book at their limit price. */
const BOOK_ORD_TYPES: readonly OrdType[] = [OrdType.Limit, OrdType.StopLimit];

/**
 * Whether a parentOrders row rests on the book at its limit: a LIMIT, or a
 * STOP_LIMIT whose stop has triggered (an untriggered stop waits in the OMS).
 */
export const restsAtLimit = (row: Readonly<Record<string, unknown>>) =>
  row.ordType === OrdType.Limit ||
  (row.ordType === OrdType.StopLimit && Number(row.triggeredAt) > 0);

/**
 * Working LIMIT orders, and STOP_LIMIT orders once triggered (OMS
 * `parentOrders`, visible to the current user) for one instrument, also
 * aggregated by side and price. Used for own-order
 * markers in depth views and the price ladder. The OMS only returns orders
 * the user is entitled to see (see oms README, permissions).
 */
export const useOwnWorkingOrders = (
  ric: string | undefined,
  { account, maxOrders = 500 }: OwnWorkingOrdersOptions = {},
): OwnWorkingOrders => {
  const dataSource = useTradingDataSource("parentOrders", {
    columns: [
      "orderId",
      "clOrdId",
      "account",
      "ric",
      "side",
      "ordType",
      "price",
      "stopPrice",
      "triggeredAt",
      "quantity",
      "leavesQty",
      "cumQty",
      "status",
    ],
  });
  const filter = ric
    ? [
        `ric = ${filterString(ric)}`,
        // Untriggered stop limits are dropped below (triggeredAt = 0).
        `ordType in [${BOOK_ORD_TYPES.map(filterString).join(",")}]`,
        `status in [${OWN_ORDER_STATUSES.map(filterString).join(",")}]`,
        account ? `account = ${filterString(account)}` : "",
      ]
        .filter(Boolean)
        .join(" and ")
    : "";
  const { rows, loaded } = useDataSourceRows(dataSource, {
    enabled: !!ric,
    filter,
    rowCount: maxOrders,
  });
  return useMemo(() => {
    const orders: OwnOrder[] = [];
    const byPrice = new Map<string, OwnOrdersAtPrice>();
    for (const row of rows) {
      if (row.ric !== ric || (account && row.account !== account)) continue;
      if (!OWN_ORDER_STATUSES.includes(row.status as OrdStatus)) continue;
      if (!restsAtLimit(row)) continue;
      const order = row as unknown as OwnOrder;
      orders.push(order);
      const key = ownOrdersKey(order.side, order.price);
      let entry = byPrice.get(key);
      if (!entry) {
        entry = {
          side: order.side,
          price: order.price,
          quantity: 0,
          orders: [],
        };
        byPrice.set(key, entry);
      }
      entry.quantity += order.leavesQty;
      entry.orders.push(order);
    }
    return { orders, byPrice, dataSource, loaded };
  }, [rows, ric, account, dataSource, loaded]);
};

/** Orders that can be cancelled / amended now (NEW, PARTIALLY_FILLED, REPLACED). */
export const actionableOrders = (orders: readonly OwnOrder[] | undefined) =>
  orders?.filter((o) => canCancel(o.status)) ?? [];
