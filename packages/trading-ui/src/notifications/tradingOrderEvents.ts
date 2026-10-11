import { OrdStatus, Side } from "@heswell/trading-schemas";
import { formatPrice, formatQuantity } from "../utils/formatting";

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

const atPrice = (price: number | undefined) =>
  price !== undefined && price > 0 ? ` @ ${formatPrice(price)}` : "";

const orderLabel = (e: TradingOrderEvent) =>
  [sideVerb(e.side), e.quantity ? formatQuantity(e.quantity) : "", e.ric]
    .filter(Boolean)
    .join(" ") + atPrice(e.price);

const ref = (e: TradingOrderEvent) => (e.orderId ? ` (${e.orderId})` : "");

/** Header, text and status for an order event toast. */
export const describeOrderEvent = (e: TradingOrderEvent): OrderEventToast => {
  switch (e.kind) {
    case "submitted":
      return {
        header: "Order sent",
        content: `${orderLabel(e)}${ref(e)}`,
        status: "info",
      };
    case "ack":
      return {
        header: "Order accepted",
        content: `${orderLabel(e)}${ref(e)}`,
        status: "info",
      };
    case "reject":
      return {
        header: "Order rejected",
        content:
          `${orderLabel(e)}${ref(e)}: ${e.reason ?? ""}${e.text ? ` ${e.text}` : ""}`.trim(),
        status: "error",
      };
    case "fill":
      return {
        header: e.status === OrdStatus.Filled ? "Order filled" : "Fill",
        content: `${sideVerb(e.side, true)} ${formatQuantity(e.fillQty)} ${e.ric ?? ""}${atPrice(e.fillPx)}${ref(e)}`,
        status: "success",
      };
    case "filled":
      return {
        header: "Order filled",
        content: `${sideVerb(e.side, true)} ${formatQuantity(e.cumQty ?? e.quantity)} ${e.ric ?? ""}${atPrice(e.avgPx)}${ref(e)}`,
        status: "success",
      };
    case "cancel":
      return {
        header: "Order cancelled",
        content: `${orderLabel(e)}${ref(e)}`,
        status: "info",
      };
    case "replace":
      return {
        header: "Order amended",
        content: `${orderLabel(e)}${ref(e)}`,
        status: "info",
      };
    case "expire":
      return {
        header: "Order expired",
        content: `${orderLabel(e)}${ref(e)}${e.cumQty ? `, ${formatQuantity(e.cumQty)} filled` : ""}`,
        status: "warning",
      };
  }
};
