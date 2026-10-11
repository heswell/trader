import {
  OrdType,
  RejectReason,
  SUPPORTED_ORD_TYPES,
  TimeInForce,
  TradingPhase,
  acceptsOrders,
  isPricedOrdType,
  type Side,
  type TimeInForce as TIF,
} from "./enums";
import { isOnTick, isValidLot, tickScheduleOf } from "./ticks";

/** Instrument static needed for order validation (subset of InstrumentRow). */
export interface InstrumentStatic {
  ric: string;
  currency: string;
  exchange: string;
  tickSize: number;
  tickBands?: string;
  lotSize: number;
}

export interface OrderReject {
  reason: RejectReason;
  text: string;
}

export interface OrderToValidate {
  side: Side;
  ordType: OrdType;
  quantity: number;
  price?: number;
  timeInForce?: TIF;
}

const reject = (reason: RejectReason, text: string): OrderReject => ({
  reason,
  text,
});

export const validateQuantity = (
  quantity: number,
  instrument: Pick<InstrumentStatic, "lotSize">,
): OrderReject | undefined => {
  if (!(Number.isFinite(quantity) && quantity > 0)) {
    return reject(RejectReason.InvalidQuantity, "quantity must be > 0");
  }
  if (!isValidLot(quantity, instrument.lotSize)) {
    return reject(
      RejectReason.InvalidLotSize,
      `quantity ${quantity} is not a multiple of lot size ${instrument.lotSize}`,
    );
  }
};

export const validatePrice = (
  price: number,
  instrument: Pick<InstrumentStatic, "tickSize" | "tickBands">,
): OrderReject | undefined => {
  if (!(Number.isFinite(price) && price > 0)) {
    return reject(RejectReason.InvalidPrice, "price must be > 0");
  }
  if (!isOnTick(price, tickScheduleOf(instrument))) {
    return reject(
      RejectReason.InvalidTickSize,
      `price ${price} is not on a valid tick`,
    );
  }
};

/**
 * Static order checks shared by the order ticket (pre-submit) and the OMS
 * (authoritative). Account / risk checks are OMS-only (Phase 2).
 */
export const validateOrder = (
  order: OrderToValidate,
  instrument: InstrumentStatic,
  phase: TradingPhase = TradingPhase.Continuous,
): OrderReject | undefined => {
  if (!SUPPORTED_ORD_TYPES.includes(order.ordType)) {
    return reject(
      RejectReason.UnsupportedOrdType,
      `order type ${order.ordType} is not supported`,
    );
  }
  if (phase === TradingPhase.Halted) {
    return reject(RejectReason.InstrumentHalted, `${instrument.ric} is halted`);
  }
  if (!acceptsOrders(phase)) {
    return reject(RejectReason.MarketClosed, `market is ${phase}`);
  }
  const tif = order.timeInForce ?? TimeInForce.Day;
  if (
    (tif === TimeInForce.ImmediateOrCancel || tif === TimeInForce.FillOrKill) &&
    phase !== TradingPhase.Continuous
  ) {
    return reject(
      RejectReason.UnsupportedTimeInForce,
      `${tif} is only accepted in continuous trading`,
    );
  }
  if (order.ordType === OrdType.Market && tif === TimeInForce.GoodTillCancel) {
    return reject(
      RejectReason.UnsupportedTimeInForce,
      "GTC is not valid for market orders",
    );
  }
  const qtyReject = validateQuantity(order.quantity, instrument);
  if (qtyReject) return qtyReject;
  if (isPricedOrdType(order.ordType)) {
    if (order.price === undefined || order.price === 0) {
      return reject(RejectReason.MissingPrice, "limit price is required");
    }
    return validatePrice(order.price, instrument);
  }
  if (order.price !== undefined && order.price !== 0) {
    return reject(
      RejectReason.InvalidPrice,
      "price must not be set for market orders",
    );
  }
};

/** Checks for amendOrder params against the instrument. */
export const validateAmend = (
  amend: { quantity?: number; price?: number },
  instrument: InstrumentStatic,
  original: { ordType: OrdType; cumQty: number },
): OrderReject | undefined => {
  if (amend.quantity !== undefined) {
    const r = validateQuantity(amend.quantity, instrument);
    if (r) return r;
    if (amend.quantity < original.cumQty) {
      return reject(
        RejectReason.InvalidQuantity,
        `quantity ${amend.quantity} is less than filled quantity ${original.cumQty}`,
      );
    }
  }
  if (amend.price !== undefined) {
    if (!isPricedOrdType(original.ordType)) {
      return reject(
        RejectReason.InvalidPrice,
        "cannot amend price of a market order",
      );
    }
    return validatePrice(amend.price, instrument);
  }
};
