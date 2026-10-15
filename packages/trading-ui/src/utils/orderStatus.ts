import { OrdStatus } from "@heswell/trading-schemas";

/** Statuses of orders that are live (cancellable / amendable once acknowledged). */
export const WORKING_STATUSES: readonly string[] = [
  OrdStatus.New,
  OrdStatus.PartiallyFilled,
  OrdStatus.Replaced,
  OrdStatus.PendingNew,
  OrdStatus.PendingCancel,
  OrdStatus.PendingReplace,
];

export const DONE_STATUSES: readonly string[] = [
  OrdStatus.Cancelled,
  OrdStatus.Rejected,
  OrdStatus.Expired,
];

/**
 * Amend and cancel are offered only for these. PENDING_* is excluded: the
 * server answers ORDER_PENDING while a request is in flight.
 */
const ACTIONABLE: readonly string[] = [
  OrdStatus.New,
  OrdStatus.PartiallyFilled,
  OrdStatus.Replaced,
];

/**
 * Amend is offered only for NEW, PARTIALLY_FILLED and REPLACED (not PENDING_*:
 * the server answers ORDER_PENDING while a request is in flight).
 */
export const isOrderAmendable = (status: unknown) =>
  typeof status === "string" && ACTIONABLE.includes(status);

export const isOrderCancellable = isOrderAmendable;

const LABELS: Record<string, string> = {
  [OrdStatus.PendingNew]: "Pending new",
  [OrdStatus.New]: "New",
  [OrdStatus.PartiallyFilled]: "Part filled",
  [OrdStatus.Filled]: "Filled",
  [OrdStatus.PendingCancel]: "Pending cancel",
  [OrdStatus.Cancelled]: "Cancelled",
  [OrdStatus.PendingReplace]: "Pending amend",
  [OrdStatus.Replaced]: "Amended",
  [OrdStatus.Rejected]: "Rejected",
  [OrdStatus.Expired]: "Expired",
};

/**
 * Display label of an order status, e.g. "Part filled"; unknown values are
 * returned as is.
 */
export const orderStatusLabel = (status: unknown) =>
  typeof status === "string" ? (LABELS[status] ?? status) : "";

const ICONS: Record<string, string> = {
  [OrdStatus.PendingNew]: "…",
  [OrdStatus.PendingCancel]: "…",
  [OrdStatus.PendingReplace]: "…",
  [OrdStatus.New]: "●",
  [OrdStatus.Replaced]: "●",
  [OrdStatus.PartiallyFilled]: "◐",
  [OrdStatus.Filled]: "✓",
  [OrdStatus.Cancelled]: "–",
  [OrdStatus.Expired]: "⌛",
  [OrdStatus.Rejected]: "✕",
};

/** A single glyph for the status (decorative; the label carries the meaning). */
export const orderStatusIcon = (status: unknown) =>
  typeof status === "string" ? (ICONS[status] ?? "") : "";
