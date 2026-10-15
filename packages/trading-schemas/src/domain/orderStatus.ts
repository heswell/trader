import { OrdStatus } from "./enums";

/**
 * Allowed OrdStatus transitions, shared by OMS (which enforces them) and UI
 * (which uses them to decide e.g. whether amend/cancel are offered).
 *
 * Conventions:
 * - An order always starts in PENDING_NEW and is acknowledged (NEW) or
 *   REJECTED before any fill is reported.
 * - IOC/FOK remainders and DAY orders at session end become EXPIRED.
 * - A cancel/replace reject returns the order to its working status
 *   (NEW / PARTIALLY_FILLED / REPLACED).
 * - Fills may race a pending cancel/replace.
 * - REPLACED is a working status: the order was amended and remains live.
 * - FILLED, CANCELLED, REJECTED and EXPIRED are terminal.
 *
 * This is only the transition table; the full reducer (quantities, exec
 * reports) lives in the OMS (Phase 2).
 */
export const ORDER_STATUS_TRANSITIONS: Readonly<
  Record<OrdStatus, readonly OrdStatus[]>
> = Object.freeze({
  [OrdStatus.PendingNew]: [OrdStatus.New, OrdStatus.Rejected],
  [OrdStatus.New]: [
    OrdStatus.PartiallyFilled,
    OrdStatus.Filled,
    OrdStatus.PendingCancel,
    OrdStatus.PendingReplace,
    OrdStatus.Cancelled,
    OrdStatus.Expired,
  ],
  [OrdStatus.PartiallyFilled]: [
    OrdStatus.PartiallyFilled,
    OrdStatus.Filled,
    OrdStatus.PendingCancel,
    OrdStatus.PendingReplace,
    OrdStatus.Cancelled,
    OrdStatus.Expired,
  ],
  [OrdStatus.Replaced]: [
    OrdStatus.PartiallyFilled,
    OrdStatus.Filled,
    OrdStatus.PendingCancel,
    OrdStatus.PendingReplace,
    OrdStatus.Cancelled,
    OrdStatus.Expired,
  ],
  [OrdStatus.PendingCancel]: [
    OrdStatus.Cancelled,
    OrdStatus.New,
    OrdStatus.PartiallyFilled,
    OrdStatus.Replaced,
    OrdStatus.Filled,
    OrdStatus.Expired,
  ],
  [OrdStatus.PendingReplace]: [
    OrdStatus.Replaced,
    OrdStatus.New,
    OrdStatus.PartiallyFilled,
    OrdStatus.Filled,
    OrdStatus.Cancelled,
    OrdStatus.Expired,
  ],
  [OrdStatus.Filled]: [],
  [OrdStatus.Cancelled]: [],
  [OrdStatus.Rejected]: [],
  [OrdStatus.Expired]: [],
});

export const INITIAL_ORDER_STATUS: OrdStatus = OrdStatus.PendingNew;

/** Whether ORDER_STATUS_TRANSITIONS allows `from` -> `to`. */
export const canTransition = (from: OrdStatus, to: OrdStatus): boolean =>
  ORDER_STATUS_TRANSITIONS[from]?.includes(to) ?? false;

/** Throws if ORDER_STATUS_TRANSITIONS does not allow `from` -> `to`. */
export const assertTransition = (from: OrdStatus, to: OrdStatus) => {
  if (!canTransition(from, to)) {
    throw Error(`Invalid order status transition ${from} -> ${to}`);
  }
};

/**
 * A status with no further transitions (FILLED, CANCELLED, REJECTED, EXPIRED).
 */
export const isTerminalStatus = (status: OrdStatus) =>
  ORDER_STATUS_TRANSITIONS[status].length === 0;

/** PENDING_NEW, PENDING_CANCEL or PENDING_REPLACE: a request is in flight. */
export const isPendingStatus = (status: OrdStatus) =>
  status === OrdStatus.PendingNew ||
  status === OrdStatus.PendingCancel ||
  status === OrdStatus.PendingReplace;

/** Live on the book with no outstanding request: amend/cancel may be sent. */
export const isWorkingStatus = (status: OrdStatus) =>
  status === OrdStatus.New ||
  status === OrdStatus.PartiallyFilled ||
  status === OrdStatus.Replaced;

export const canCancel = isWorkingStatus;
export const canAmend = isWorkingStatus;

/** Working return status after a cancel/replace reject or a fill. */
export const workingStatusFor = (cumQty: number, amended: boolean) =>
  cumQty > 0
    ? OrdStatus.PartiallyFilled
    : amended
      ? OrdStatus.Replaced
      : OrdStatus.New;
