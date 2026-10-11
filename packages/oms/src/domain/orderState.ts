import {
  canTransition,
  INITIAL_ORDER_STATUS,
  isPendingStatus,
  isTerminalStatus,
  OrdStatus,
  type RejectReason,
  workingStatusFor,
} from "@heswell/trading-schemas";

/**
 * Quantities and status of one order (parent or child). The reducer below is
 * the only way an OrderState changes, so every status change is checked
 * against ORDER_STATUS_TRANSITIONS.
 */
export interface OrderState {
  readonly status: OrdStatus;
  /** Total order quantity (FIX OrderQty). */
  readonly quantity: number;
  /** Limit price, 0 for market orders. */
  readonly price: number;
  readonly cumQty: number;
  readonly leavesQty: number;
  readonly avgPx: number;
  readonly lastQty: number;
  readonly lastPx: number;
  /** Incremented by each applied amend. */
  readonly version: number;
  /** True once an amend has been applied (REPLACED is the working status). */
  readonly amended: boolean;
  /** The amend in flight while PENDING_REPLACE. */
  readonly pendingAmend?: { quantity: number; price: number };
  readonly rejectReason?: RejectReason;
  readonly text?: string;
}

export type OrderEvent =
  /** Exchange accepted the order. */
  | { type: "ack" }
  /** Order rejected (risk or exchange). */
  | { type: "reject"; reason: RejectReason; text?: string }
  | { type: "fill"; qty: number; px: number }
  | { type: "pendingCancel" }
  | { type: "cancelled"; text?: string }
  | { type: "cancelReject"; reason: RejectReason; text?: string }
  | { type: "pendingReplace"; quantity: number; price: number }
  /** Amend applied. quantity is the new total. */
  | { type: "replaced"; quantity: number; price: number }
  | { type: "replaceReject"; reason: RejectReason; text?: string }
  /** IOC/FOK/market remainder, or a DAY order at end of day. */
  | { type: "expired"; reason?: RejectReason; text?: string };

export class OrderStateError extends Error {
  constructor(
    readonly status: OrdStatus,
    readonly event: OrderEvent["type"],
    message = `cannot apply ${event} to an order in status ${status}`,
  ) {
    super(message);
    this.name = "OrderStateError";
  }
}

export const newOrderState = (quantity: number, price: number): OrderState => {
  if (!(quantity > 0)) throw Error(`quantity must be > 0, got ${quantity}`);
  return {
    status: INITIAL_ORDER_STATUS,
    quantity,
    price,
    cumQty: 0,
    leavesQty: quantity,
    avgPx: 0,
    lastQty: 0,
    lastPx: 0,
    version: 0,
    amended: false,
  };
};

const to = (state: OrderState, next: OrdStatus, event: OrderEvent["type"]) => {
  if (!canTransition(state.status, next)) {
    throw new OrderStateError(
      state.status,
      event,
      `invalid order status transition ${state.status} -> ${next} (${event})`,
    );
  }
  return next;
};

/**
 * Pure FIX-style order reducer. Illegal events throw OrderStateError and leave
 * the input untouched.
 *
 * Race rules (fills and responses can cross a cancel/replace request):
 * - A partial fill while PENDING_CANCEL / PENDING_REPLACE updates quantities
 *   but keeps the pending status; a fill that completes the order -> FILLED.
 * - A cancel/replace reject returns to the working status
 *   (workingStatusFor(cumQty, amended)). If the order already reached a
 *   terminal status (e.g. filled while the cancel was in flight) the late
 *   reject is ignored.
 */
export const reduceOrder = (
  state: OrderState,
  event: OrderEvent,
): OrderState => {
  const { status } = state;
  switch (event.type) {
    case "ack":
      return { ...state, status: to(state, OrdStatus.New, event.type) };

    case "reject":
      return {
        ...state,
        status: to(state, OrdStatus.Rejected, event.type),
        leavesQty: 0,
        rejectReason: event.reason,
        text: event.text,
      };

    case "fill": {
      const { qty, px } = event;
      if (!(qty > 0 && px > 0)) {
        throw new OrderStateError(
          status,
          event.type,
          `invalid fill ${qty}@${px}`,
        );
      }
      if (status === OrdStatus.PendingNew || isTerminalStatus(status)) {
        throw new OrderStateError(status, event.type);
      }
      const cumQty = state.cumQty + qty;
      if (cumQty > state.quantity) {
        throw new OrderStateError(
          status,
          event.type,
          `overfill: cumQty ${cumQty} > quantity ${state.quantity}`,
        );
      }
      const leavesQty = state.quantity - cumQty;
      const filled = leavesQty === 0;
      const next = filled
        ? OrdStatus.Filled
        : isPendingStatus(status)
          ? status
          : OrdStatus.PartiallyFilled;
      return {
        ...state,
        status: next === status ? status : to(state, next, event.type),
        cumQty,
        leavesQty,
        avgPx: (state.avgPx * state.cumQty + px * qty) / cumQty,
        lastQty: qty,
        lastPx: px,
        pendingAmend: filled ? undefined : state.pendingAmend,
      };
    }

    case "pendingCancel":
      return {
        ...state,
        status: to(state, OrdStatus.PendingCancel, event.type),
      };

    case "cancelled":
      return {
        ...state,
        status: to(state, OrdStatus.Cancelled, event.type),
        leavesQty: 0,
        pendingAmend: undefined,
        text: event.text ?? state.text,
      };

    case "cancelReject":
    case "replaceReject": {
      if (isTerminalStatus(status)) return state;
      const expected =
        event.type === "cancelReject"
          ? OrdStatus.PendingCancel
          : OrdStatus.PendingReplace;
      if (status !== expected) throw new OrderStateError(status, event.type);
      return {
        ...state,
        status: to(
          state,
          workingStatusFor(state.cumQty, state.amended),
          event.type,
        ),
        pendingAmend: undefined,
        text: event.text,
      };
    }

    case "pendingReplace": {
      const { quantity, price } = event;
      if (quantity < state.cumQty) {
        throw new OrderStateError(
          status,
          event.type,
          `quantity ${quantity} < cumQty ${state.cumQty}`,
        );
      }
      return {
        ...state,
        status: to(state, OrdStatus.PendingReplace, event.type),
        pendingAmend: { quantity, price },
      };
    }

    case "replaced": {
      if (status !== OrdStatus.PendingReplace) {
        throw new OrderStateError(status, event.type);
      }
      const { quantity, price } = event;
      const leavesQty = Math.max(0, quantity - state.cumQty);
      return {
        ...state,
        status: to(
          state,
          leavesQty === 0
            ? OrdStatus.Filled
            : workingStatusFor(state.cumQty, true),
          event.type,
        ),
        quantity,
        price,
        leavesQty,
        version: state.version + 1,
        amended: true,
        pendingAmend: undefined,
      };
    }

    case "expired":
      return {
        ...state,
        status: to(state, OrdStatus.Expired, event.type),
        leavesQty: 0,
        pendingAmend: undefined,
        rejectReason: event.reason ?? state.rejectReason,
        text: event.text ?? state.text,
      };
  }
};

/** Apply a sequence of events (convenience for tests and replay). */
export const reduceOrderEvents = (
  state: OrderState,
  events: readonly OrderEvent[],
) => events.reduce(reduceOrder, state);
