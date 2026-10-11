/**
 * Domain enumerations shared by exchange-sim, OMS, trading-ui and test data.
 *
 * Each enum is a frozen const object plus a string-literal union type of the
 * same name. The string values are what is stored in Vuu `string` columns and
 * sent in RPC params, so they must never be renamed without a migration.
 */

type ValueOf<T> = T[keyof T];

const values = <T extends Record<string, string>>(e: T) =>
  Object.freeze(Object.values(e)) as readonly ValueOf<T>[];

export const Side = Object.freeze({
  Buy: "BUY",
  Sell: "SELL",
} as const);
export type Side = ValueOf<typeof Side>;
export const SIDES = values(Side);

export const oppositeSide = (side: Side): Side =>
  side === Side.Buy ? Side.Sell : Side.Buy;

/** STOP and STOP_LIMIT are reserved: they are valid values but not yet accepted by the OMS. */
export const OrdType = Object.freeze({
  Market: "MARKET",
  Limit: "LIMIT",
  Stop: "STOP",
  StopLimit: "STOP_LIMIT",
} as const);
export type OrdType = ValueOf<typeof OrdType>;
export const ORD_TYPES = values(OrdType);
export const SUPPORTED_ORD_TYPES: readonly OrdType[] = Object.freeze([
  OrdType.Market,
  OrdType.Limit,
]);
export const isPricedOrdType = (ordType: OrdType) =>
  ordType === OrdType.Limit || ordType === OrdType.StopLimit;

export const TimeInForce = Object.freeze({
  Day: "DAY",
  GoodTillCancel: "GTC",
  ImmediateOrCancel: "IOC",
  FillOrKill: "FOK",
} as const);
export type TimeInForce = ValueOf<typeof TimeInForce>;
export const TIME_IN_FORCE_VALUES = values(TimeInForce);

/** FIX OrdStatus (tag 39) subset. */
export const OrdStatus = Object.freeze({
  PendingNew: "PENDING_NEW",
  New: "NEW",
  PartiallyFilled: "PARTIALLY_FILLED",
  Filled: "FILLED",
  PendingCancel: "PENDING_CANCEL",
  Cancelled: "CANCELLED",
  PendingReplace: "PENDING_REPLACE",
  Replaced: "REPLACED",
  Rejected: "REJECTED",
  Expired: "EXPIRED",
} as const);
export type OrdStatus = ValueOf<typeof OrdStatus>;
export const ORD_STATUSES = values(OrdStatus);

/**
 * FIX ExecType (tag 150). As in FIX 4.4+, fills are reported with ExecType
 * TRADE; whether the order is partially or fully filled is carried by OrdStatus.
 */
export const ExecType = Object.freeze({
  PendingNew: "PENDING_NEW",
  New: "NEW",
  Trade: "TRADE",
  PendingCancel: "PENDING_CANCEL",
  Cancelled: "CANCELLED",
  PendingReplace: "PENDING_REPLACE",
  Replaced: "REPLACED",
  Rejected: "REJECTED",
  Expired: "EXPIRED",
} as const);
export type ExecType = ValueOf<typeof ExecType>;
export const EXEC_TYPES = values(ExecType);

/** Liquidity indicator on a fill (FIX LastLiquidityInd). */
export const Liquidity = Object.freeze({
  Added: "ADDED",
  Removed: "REMOVED",
  Auction: "AUCTION",
} as const);
export type Liquidity = ValueOf<typeof Liquidity>;
export const LIQUIDITY_VALUES = values(Liquidity);

export const TradingPhase = Object.freeze({
  Closed: "CLOSED",
  PreOpen: "PRE_OPEN",
  OpeningAuction: "OPENING_AUCTION",
  Continuous: "CONTINUOUS",
  ClosingAuction: "CLOSING_AUCTION",
  PostClose: "POST_CLOSE",
  Halted: "HALTED",
} as const);
export type TradingPhase = ValueOf<typeof TradingPhase>;
export const TRADING_PHASES = values(TradingPhase);

/** Phases in which new orders / amends may be submitted to the exchange. */
export const acceptsOrders = (phase: TradingPhase) =>
  phase === TradingPhase.PreOpen ||
  phase === TradingPhase.OpeningAuction ||
  phase === TradingPhase.Continuous ||
  phase === TradingPhase.ClosingAuction;

/** Phases in which incoming orders match immediately against the book. */
export const isContinuousMatching = (phase: TradingPhase) =>
  phase === TradingPhase.Continuous;

/**
 * Reject reason codes, carried in `parentOrders.rejectReason` /
 * `childOrders.rejectReason` and as the code prefix of RPC ERROR_RESULT
 * messages (see `formatRpcError`).
 */
export const RejectReason = Object.freeze({
  InvalidRequest: "INVALID_REQUEST",
  UnknownInstrument: "UNKNOWN_INSTRUMENT",
  UnknownAccount: "UNKNOWN_ACCOUNT",
  AccountDisabled: "ACCOUNT_DISABLED",
  UnknownOrder: "UNKNOWN_ORDER",
  DuplicateClOrdId: "DUPLICATE_CLORDID",
  UnsupportedOrdType: "UNSUPPORTED_ORD_TYPE",
  UnsupportedTimeInForce: "UNSUPPORTED_TIF",
  MissingPrice: "MISSING_PRICE",
  InvalidPrice: "INVALID_PRICE",
  InvalidTickSize: "INVALID_TICK_SIZE",
  InvalidQuantity: "INVALID_QUANTITY",
  InvalidLotSize: "INVALID_LOT_SIZE",
  ExceedsMaxQuantity: "EXCEEDS_MAX_QUANTITY",
  ExceedsMaxNotional: "EXCEEDS_MAX_NOTIONAL",
  PriceOutsideCollar: "PRICE_OUTSIDE_COLLAR",
  RestrictedInstrument: "RESTRICTED_INSTRUMENT",
  InstrumentHalted: "INSTRUMENT_HALTED",
  MarketClosed: "MARKET_CLOSED",
  NoLiquidity: "NO_LIQUIDITY",
  FokNotFillable: "FOK_NOT_FILLABLE",
  TooLateToAmend: "TOO_LATE_TO_AMEND",
  TooLateToCancel: "TOO_LATE_TO_CANCEL",
  OrderPending: "ORDER_PENDING",
  PermissionDenied: "PERMISSION_DENIED",
  InternalError: "INTERNAL_ERROR",
} as const);
export type RejectReason = ValueOf<typeof RejectReason>;
export const REJECT_REASONS = values(RejectReason);

/** Bot categories driven by the exchange-sim `setBotRate` admin RPC. */
export const BotType = Object.freeze({
  MarketMaker: "MARKET_MAKER",
  Taker: "TAKER",
  All: "ALL",
} as const);
export type BotType = ValueOf<typeof BotType>;
export const BOT_TYPES = values(BotType);

export const isEnumValue = <T extends string>(
  allowed: readonly T[],
  value: unknown,
): value is T => typeof value === "string" && allowed.includes(value as T);
