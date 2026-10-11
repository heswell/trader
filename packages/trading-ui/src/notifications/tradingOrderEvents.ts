import { OrdStatus, Side } from "@heswell/trading-schemas";
import {
  formatPrice,
  formatQuantity,
  type PriceFormat,
} from "../utils/formatting";

/**
 * Something that happened to an order, from any source: the order ticket's
 * RPC result, a ladder / grid quick order, or the parentOrders / fills
 * streams. The notification provider turns these into toasts.
 */
export type TradingOrderEventKind =
  /** Request accepted but not yet acknowledged (PENDING_NEW). */
  | "submitted"
  /** Order acknowledged (NEW, or filled straight away). */
  | "ack"
  /** Rejected by validation, risk, permissions or the exchange. */
  | "reject"
  /** One execution (fills row). */
  | "fill"
  /** Order completely filled. */
  | "filled"
  | "cancel"
  | "replace"
  /** IOC / FOK / market remainder or DAY order expired. */
  | "expire";

export const TRADING_ORDER_EVENT_KINDS: readonly TradingOrderEventKind[] = [
  "submitted",
  "ack",
  "reject",
  "fill",
  "filled",
  "cancel",
  "replace",
  "expire",
];

export interface TradingOrderEvent {
  kind: TradingOrderEventKind;
  orderId?: string;
  clOrdId?: string;
  ric?: string;
  side?: Side | string;
  /** Order quantity. */
  quantity?: number;
  /** Limit price. */
  price?: number;
  account?: string;
  status?: OrdStatus | string;
  /** Reject reason code (RejectReason) and text. */
  reason?: string;
  text?: string;
  /** Fill: execution id, quantity and price. */
  execId?: string;
  fillQty?: number;
  fillPx?: number;
  cumQty?: number;
  avgPx?: number;
  currency?: string;
  /** Who raised it, e.g. "orderTicket", "ladder", "stream". */
  source?: string;
}

/** Map an order status to the event it represents, if any. */
export const orderEventKindForStatus = (
  status: unknown,
): TradingOrderEventKind | undefined => {
  switch (status) {
    case OrdStatus.PendingNew:
      return "submitted";
    case OrdStatus.New:
      return "ack";
    case OrdStatus.Filled:
      return "filled";
    case OrdStatus.Rejected:
      return "reject";
    case OrdStatus.Cancelled:
      return "cancel";
    case OrdStatus.Replaced:
      return "replace";
    case OrdStatus.Expired:
      return "expire";
    default:
      return undefined;
  }
};

/**
 * A "reject" event for a failed order RPC (`TradingRpcError` or anything
 * thrown), for components that report their own requests (ladder, blotter).
 */
export const rpcRejectEvent = (
  error: unknown,
  event: Omit<TradingOrderEvent, "kind">,
): TradingOrderEvent => {
  const { reason, text } =
    error && typeof error === "object" && "reason" in error
      ? (error as { reason: string; text?: string })
      : { reason: "INTERNAL_ERROR", text: String(error) };
  return { ...event, kind: "reject", reason, text };
};

/** Key used to drop duplicates of the same event from different sources. */
export const orderEventKey = (event: TradingOrderEvent) =>
  event.kind === "fill"
    ? `fill:${event.execId ?? `${event.orderId}:${event.cumQty}:${event.fillQty}`}`
    : `${event.kind}:${event.clOrdId || event.orderId || ""}`;

export type ToastStatus = "success" | "error" | "info" | "warning";

export interface OrderEventToast {
  header: string;
  content: string;
  status: ToastStatus;
}

const sideVerb = (side: unknown, past = false) =>
  side === Side.Buy
    ? past
      ? "Bought"
      : "Buy"
    : side === Side.Sell
      ? past
        ? "Sold"
        : "Sell"
      : "";

/**
 * Price format (decimals / tick size) of a ric, e.g. from the
 * InstrumentLookup. Without one prices show 2 decimals.
 */
export type OrderEventPriceFormat = (
  ric: string | undefined,
) => PriceFormat | undefined;

const atPrice = (price: number | undefined, format: PriceFormat | undefined) =>
  price !== undefined && price > 0 ? ` @ ${formatPrice(price, format)}` : "";

const orderLabel = (e: TradingOrderEvent, format: PriceFormat | undefined) =>
  [sideVerb(e.side), e.quantity ? formatQuantity(e.quantity) : "", e.ric]
    .filter(Boolean)
    .join(" ") + atPrice(e.price, format);

const ref = (e: TradingOrderEvent) => (e.orderId ? ` (${e.orderId})` : "");

/**
 * Header, text and status for an order event toast. Prices are formatted
 * with the instrument's decimals / tick size when `priceFormat` knows it.
 */
export const describeOrderEvent = (
  e: TradingOrderEvent,
  priceFormat?: OrderEventPriceFormat,
): OrderEventToast => {
  const format = priceFormat?.(e.ric);
  switch (e.kind) {
    case "submitted":
      return {
        header: "Order sent",
        content: `${orderLabel(e, format)}${ref(e)}`,
        status: "info",
      };
    case "ack":
      return {
        header: "Order accepted",
        content: `${orderLabel(e, format)}${ref(e)}`,
        status: "info",
      };
    case "reject":
      return {
        header: "Order rejected",
        content:
          `${orderLabel(e, format)}${ref(e)}: ${e.reason ?? ""}${e.text ? ` ${e.text}` : ""}`.trim(),
        status: "error",
      };
    case "fill":
      return {
        header: e.status === OrdStatus.Filled ? "Order filled" : "Fill",
        content: `${sideVerb(e.side, true)} ${formatQuantity(e.fillQty)} ${e.ric ?? ""}${atPrice(e.fillPx, format)}${ref(e)}`,
        status: "success",
      };
    case "filled":
      return {
        header: "Order filled",
        content: `${sideVerb(e.side, true)} ${formatQuantity(e.cumQty ?? e.quantity)} ${e.ric ?? ""}${atPrice(e.avgPx, format)}${ref(e)}`,
        status: "success",
      };
    case "cancel":
      return {
        header: "Order cancelled",
        content: `${orderLabel(e, format)}${ref(e)}`,
        status: "info",
      };
    case "replace":
      return {
        header: "Order amended",
        content: `${orderLabel(e, format)}${ref(e)}`,
        status: "info",
      };
    case "expire":
      return {
        header: "Order expired",
        content: `${orderLabel(e, format)}${ref(e)}${e.cumQty ? `, ${formatQuantity(e.cumQty)} filled` : ""}`,
        status: "warning",
      };
  }
};
