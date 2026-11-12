import type { OrdStatus, Side } from "@heswell/trading-schemas";
import { useMemo } from "react";
import { useDataSourceRows } from "../data/useDataSourceRows";
import { useTradingDataSource } from "../data/useTradingDataSource";
import { filterString } from "../utils/filters";
import { type LadderQueue, useBookQueue } from "./useBookQueue";
import {
  type InstrumentPrice,
  type MarketDepthState,
  useInstrumentPrice,
  useMarketDepth,
} from "./useMarketData";
import { OWN_ORDER_STATUSES } from "./useOwnWorkingOrders";

/** The parent order an order book view is about (OMS `parentOrders`). */
export interface OrderBookParentOrder {
  orderId: string;
  ric: string;
  side: Side;
  ordType: string;
  strategy?: string;
  timeInForce?: string;
  quantity: number;
  /** Limit price; 0 or absent for a market order. */
  price?: number;
  /** STOP / STOP_LIMIT trigger price; absent for other types. */
  stopPrice?: number;
  /** When the stop triggered (epoch ms); absent while waiting / not a stop. */
  triggeredAt?: number;
  cumQty: number;
  avgPx?: number;
  status: OrdStatus;
}

/** Where one child order rests in the L3 book. */
export interface QueuePosition {
  queue: LadderQueue;
  /** 1-based place in the queue. */
  rank: number;
  /** Size ahead of the order. */
  ahead: number;
}

/** A child (street) order of the parent order (OMS `childOrders`). */
export interface OrderBookChildOrder {
  childOrderId: string;
  exchangeOrderId?: string;
  side: Side;
  price: number;
  quantity: number;
  cumQty: number;
  /** Open quantity on the exchange. */
  leavesQty: number;
  status: OrdStatus;
  /** Working on the exchange (new, partly filled, being amended...). */
  working: boolean;
  /** Its place in the L3 book, once bookOrders has it. */
  position?: QueuePosition;
}

export interface OrderBookState {
  order?: OrderBookParentOrder;
  /**
   * The live child orders (working or in flight, see OWN_ORDER_STATUSES),
   * oldest first. Filled and cancelled ones are left out: an algo order
   * sends thousands of children over its life.
   */
  children: readonly OrderBookChildOrder[];
  /** Static data and live prices of the order's instrument. */
  instrument?: InstrumentPrice;
  /** L2: aggregated levels, best first. */
  depth: MarketDepthState;
  /** L3: the queue at each price, keyed by `ownOrdersKey(side, price)`. */
  queues: ReadonlyMap<string, LadderQueue>;
  /** Exchange ids of the working child orders (marked in `queues`). */
  ownOrderIds: ReadonlySet<string>;
  /** bookOrders loaded and the instrument has resting orders. */
  l3Available: boolean;
  /** The instrument has more resting orders than were loaded. */
  l3Truncated: boolean;
  loaded: boolean;
}

export interface OrderBookOptions {
  /** L2 levels per side. Default 10. */
  levels?: number;
}

const PARENT_COLUMNS = [
  "orderId",
  "ric",
  "side",
  "ordType",
  "strategy",
  "timeInForce",
  "quantity",
  "price",
  "stopPrice",
  "triggeredAt",
  "cumQty",
  "avgPx",
  "status",
];

const CHILD_COLUMNS = [
  "childOrderId",
  "parentOrderId",
  "exchangeOrderId",
  "side",
  "price",
  "quantity",
  "cumQty",
  "leavesQty",
  "status",
  "created",
];

const WORKING = new Set<string>(OWN_ORDER_STATUSES);
const NO_IDS: ReadonlySet<string> = new Set();

const toNumber = (value: unknown) =>
  typeof value === "number" ? value : Number(value ?? 0);

/** Each order id in `queues` with its queue, rank and size ahead. */
const positionsOf = (
  queues: ReadonlyMap<string, LadderQueue>,
  orderIds: ReadonlySet<string>,
) => {
  const positions = new Map<string, QueuePosition>();
  if (orderIds.size === 0) return positions;
  for (const queue of queues.values()) {
    if (queue.ownRank === undefined) continue;
    let ahead = 0;
    queue.orders.forEach((order, i) => {
      if (orderIds.has(order.orderId)) {
        positions.set(order.orderId, { queue, rank: i + 1, ahead });
      }
      ahead += order.size;
    });
  }
  return positions;
};

/**
 * One parent order with the book it is working in: its child orders, the
 * instrument's L2 depth (EXCHANGE `depth`) and L3 queues (EXCHANGE
 * `bookOrders`), the working child orders marked with their queue position.
 * Subscribes only while `orderId` is set.
 */
export const useOrderBook = (
  orderId: string | undefined,
  { levels = 10 }: OrderBookOptions = {},
): OrderBookState => {
  const parentSource = useTradingDataSource("parentOrders", {
    columns: PARENT_COLUMNS,
  });
  const { rows: parentRows, loaded: parentLoaded } = useDataSourceRows(
    parentSource,
    {
      enabled: !!orderId,
      filter: orderId ? `orderId = ${filterString(orderId)}` : "",
      rowCount: 1,
    },
  );
  const childSource = useTradingDataSource("childOrders", {
    columns: CHILD_COLUMNS,
  });
  // Only live children: an algo re-places its slices several times a
  // second, so a long-running order has thousands of filled and cancelled
  // children, and a row limit on all of them would cut off the live ones.
  const { rows: childRows } = useDataSourceRows(childSource, {
    enabled: !!orderId,
    filter: orderId
      ? `parentOrderId = ${filterString(orderId)} and status in [${OWN_ORDER_STATUSES.map(filterString).join(",")}]`
      : "",
    rowCount: 100,
  });

  const parentRow = parentRows[0];
  const order = useMemo<OrderBookParentOrder | undefined>(() => {
    if (!parentRow || parentRow.orderId !== orderId) return undefined;
    return {
      orderId: String(parentRow.orderId),
      ric: String(parentRow.ric),
      side: parentRow.side as Side,
      ordType: String(parentRow.ordType ?? ""),
      strategy: (parentRow.strategy as string) || undefined,
      timeInForce: (parentRow.timeInForce as string) || undefined,
      quantity: toNumber(parentRow.quantity),
      price:
        typeof parentRow.price === "number" && parentRow.price > 0
          ? parentRow.price
          : undefined,
      stopPrice:
        typeof parentRow.stopPrice === "number" && parentRow.stopPrice > 0
          ? parentRow.stopPrice
          : undefined,
      triggeredAt:
        typeof parentRow.triggeredAt === "number" && parentRow.triggeredAt > 0
          ? parentRow.triggeredAt
          : undefined,
      cumQty: toNumber(parentRow.cumQty),
      avgPx:
        typeof parentRow.avgPx === "number" && parentRow.avgPx > 0
          ? parentRow.avgPx
          : undefined,
      status: parentRow.status as OrdStatus,
    };
  }, [parentRow, orderId]);

  const ric = order?.ric;
  const instrument = useInstrumentPrice(ric);
  const depth = useMarketDepth(ric, { levels });

  // a stable key, so the id set (and the queues built from it) only
  // change when the working exchange ids do
  const idKey = useMemo(() => {
    const ids: string[] = [];
    for (const row of childRows) {
      if (row.parentOrderId !== orderId) continue;
      const id = row.exchangeOrderId;
      if (typeof id === "string" && id && WORKING.has(String(row.status))) {
        ids.push(id);
      }
    }
    return ids.sort().join(",");
  }, [childRows, orderId]);
  const ownOrderIds = useMemo(
    () => (idKey ? new Set(idKey.split(",")) : NO_IDS),
    [idKey],
  );
  const book = useBookQueue(ric, { ownOrderIds });

  const children = useMemo(() => {
    const positions = positionsOf(book.queues, ownOrderIds);
    return childRows
      .filter((row) => row.parentOrderId === orderId)
      .sort((a, b) => toNumber(a.created) - toNumber(b.created))
      .map<OrderBookChildOrder>((row) => {
        const exchangeOrderId =
          typeof row.exchangeOrderId === "string" && row.exchangeOrderId
            ? row.exchangeOrderId
            : undefined;
        return {
          childOrderId: String(row.childOrderId),
          exchangeOrderId,
          side: row.side as Side,
          price: toNumber(row.price),
          quantity: toNumber(row.quantity),
          cumQty: toNumber(row.cumQty),
          leavesQty: toNumber(row.leavesQty),
          status: row.status as OrdStatus,
          working: WORKING.has(String(row.status)),
          position: exchangeOrderId
            ? positions.get(exchangeOrderId)
            : undefined,
        };
      });
  }, [childRows, orderId, book.queues, ownOrderIds]);

  return {
    order,
    children,
    instrument,
    depth,
    queues: book.queues,
    ownOrderIds,
    l3Available: book.loaded && book.orderCount > 0,
    l3Truncated: book.truncated,
    loaded: parentLoaded,
  };
};
