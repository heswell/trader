import {
  type InstrumentType,
  OrdType,
  RejectReason,
  SUPPORTED_ORD_TYPES,
  TimeInForce,
  TradingPhase,
  acceptsOrders,
  isPricedOrdType,
  isStopOrdType,
  STOP_TIME_IN_FORCE_VALUES,
  Side,
  type TimeInForce as TIF,
} from "./enums";
import { isOnTick, isValidLot, tickScheduleOf } from "./ticks";

/** Instrument static needed for order validation (subset of InstrumentRow). */
export interface InstrumentStatic {
  ric: string;
  currency: string;
  exchange: string;
  /** GICS sector (instruments.sector), when known. */
  sector?: string;
  tickSize: number;
  tickBands?: string;
  lotSize: number;
  /** EQUITY when absent. */
  instrumentType?: InstrumentType;
  /** Futures: ric of the underlying instrument. */
  underlying?: string;
  /** Futures: last trading time (epoch ms). */
  expiry?: number;
  /** Futures: final settlement price, set once the contract has expired. */
  settlementPrice?: number;
  /**
   * Price-unit value of one unit of quantity per unit of price: 1 for an
   * equity, e.g. 10 for a future quoted per share on 10 shares. 1 when absent.
   */
  contractMultiplier?: number;
}

/** The instrument's contract multiplier (1 when absent or invalid). */
export const contractMultiplierOf = (
  instrument: Pick<InstrumentStatic, "contractMultiplier"> | undefined,
): number => {
  const multiplier = instrument?.contractMultiplier;
  return multiplier !== undefined && multiplier > 0 ? multiplier : 1;
};

/**
 * USD value of one unit of quantity at a price of 1: the currency conversion
 * (usdPerPriceUnit) times the contract multiplier. Notional in USD is
 * `quantity * price * usdPerUnit(instrument)`.
 */
export const usdPerUnit = (
  instrument: Pick<InstrumentStatic, "contractMultiplier"> & {
    usdPerPriceUnit: number;
  },
): number => instrument.usdPerPriceUnit * contractMultiplierOf(instrument);

export interface OrderReject {
  reason: RejectReason;
  text: string;
}

export interface OrderToValidate {
  side: Side;
  ordType: OrdType;
  quantity: number;
  price?: number;
  /** STOP / STOP_LIMIT trigger price. */
  stopPrice?: number;
  timeInForce?: TIF;
}

const reject = (reason: RejectReason, text: string): OrderReject => ({
  reason,
  text,
});

/**
 * An INVALID_QUANTITY reject unless `quantity` is > 0 and a multiple of the
 * instrument's lot size.
 */
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

/**
 * An INVALID_PRICE reject unless `price` is > 0 and on the instrument's tick
 * schedule.
 */
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
 * An INVALID_STOP_PRICE reject unless `stopPrice` is > 0 and on the
 * instrument's tick schedule.
 */
export const validateStopPrice = (
  stopPrice: number,
  instrument: Pick<InstrumentStatic, "tickSize" | "tickBands">,
): OrderReject | undefined => {
  if (!(Number.isFinite(stopPrice) && stopPrice > 0)) {
    return reject(RejectReason.InvalidStopPrice, "stop price must be > 0");
  }
  if (!isOnTick(stopPrice, tickScheduleOf(instrument))) {
    return reject(
      RejectReason.InvalidStopPrice,
      `stop price ${stopPrice} is not on a valid tick`,
    );
  }
};

/**
 * A STOP_LIMIT must be able to fill when it triggers: a buy's limit at or
 * above its stop, a sell's at or below.
 */
export const validateStopLimitPrices = (
  side: Side,
  price: number,
  stopPrice: number,
): OrderReject | undefined => {
  if (side === Side.Buy ? price < stopPrice : price > stopPrice) {
    return reject(
      RejectReason.InvalidPrice,
      side === Side.Buy
        ? `limit price ${price} is below the stop price ${stopPrice}`
        : `limit price ${price} is above the stop price ${stopPrice}`,
    );
  }
};

/**
 * A stop must not already be reached: a buy stop above the market price, a
 * sell stop below it. `marketPrice` is the last trade (else mid / reference);
 * no check without one.
 */
export const validateStopTrigger = (
  side: Side,
  stopPrice: number,
  marketPrice: number | undefined,
): OrderReject | undefined => {
  if (!marketPrice || !(marketPrice > 0)) return;
  if (side === Side.Buy ? stopPrice <= marketPrice : stopPrice >= marketPrice) {
    return reject(
      RejectReason.InvalidStopPrice,
      side === Side.Buy
        ? `buy stop ${stopPrice} must be above the market price ${marketPrice}`
        : `sell stop ${stopPrice} must be below the market price ${marketPrice}`,
    );
  }
};

/** Whether a trade at `price` reaches the stop: buys at or above, sells at or below. */
export const isStopTriggered = (
  side: Side,
  stopPrice: number,
  price: number,
) => (side === Side.Buy ? price >= stopPrice : price <= stopPrice);

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
  const stop = isStopOrdType(order.ordType);
  if (stop && !STOP_TIME_IN_FORCE_VALUES.includes(tif)) {
    return reject(
      RejectReason.UnsupportedTimeInForce,
      `${tif} is not valid for stop orders`,
    );
  }
  const qtyReject = validateQuantity(order.quantity, instrument);
  if (qtyReject) return qtyReject;
  if (isPricedOrdType(order.ordType)) {
    if (order.price === undefined || order.price === 0) {
      return reject(RejectReason.MissingPrice, "limit price is required");
    }
    const priceReject = validatePrice(order.price, instrument);
    if (priceReject) return priceReject;
  } else if (order.price !== undefined && order.price !== 0) {
    return reject(
      RejectReason.InvalidPrice,
      order.ordType === OrdType.Stop
        ? "price must not be set for stop orders (use STOP_LIMIT)"
        : "price must not be set for market orders",
    );
  }
  if (!stop) {
    if (order.stopPrice !== undefined && order.stopPrice !== 0) {
      return reject(
        RejectReason.InvalidStopPrice,
        "stop price is only valid for STOP / STOP_LIMIT orders",
      );
    }
    return;
  }
  if (order.stopPrice === undefined || order.stopPrice === 0) {
    return reject(RejectReason.MissingStopPrice, "stop price is required");
  }
  const stopReject = validateStopPrice(order.stopPrice, instrument);
  if (stopReject) return stopReject;
  if (order.ordType === OrdType.StopLimit && order.price) {
    return validateStopLimitPrices(order.side, order.price, order.stopPrice);
  }
};

/**
 * Checks for amendOrder params against the instrument. With the original's
 * side, price and stopPrice, a STOP_LIMIT's limit / stop pair is checked too.
 */
export const validateAmend = (
  amend: { quantity?: number; price?: number; stopPrice?: number },
  instrument: InstrumentStatic,
  original: {
    ordType: OrdType;
    cumQty: number;
    side?: Side;
    price?: number;
    stopPrice?: number;
  },
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
        original.ordType === OrdType.Stop
          ? "cannot amend price of a stop order"
          : "cannot amend price of a market order",
      );
    }
    const r = validatePrice(amend.price, instrument);
    if (r) return r;
  }
  if (amend.stopPrice !== undefined) {
    if (!isStopOrdType(original.ordType)) {
      return reject(
        RejectReason.InvalidStopPrice,
        `cannot amend stop price of a ${original.ordType} order`,
      );
    }
    const r = validateStopPrice(amend.stopPrice, instrument);
    if (r) return r;
  }
  const price = amend.price ?? original.price;
  const stopPrice = amend.stopPrice ?? original.stopPrice;
  if (
    original.ordType === OrdType.StopLimit &&
    original.side &&
    price &&
    stopPrice
  ) {
    return validateStopLimitPrices(original.side, price, stopPrice);
  }
};
