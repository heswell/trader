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

/** BUY for SELL and SELL for BUY. */
export const oppositeSide = (side: Side): Side =>
  side === Side.Buy ? Side.Sell : Side.Buy;

/**
 * STOP and STOP_LIMIT are held by the OMS until a trade on the tape reaches
 * the stop price, then sent to the exchange as a MARKET / LIMIT order.
 */
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
  OrdType.Stop,
  OrdType.StopLimit,
]);
/** Whether an order type needs a limit price (LIMIT, STOP_LIMIT). */
export const isPricedOrdType = (ordType: OrdType) =>
  ordType === OrdType.Limit || ordType === OrdType.StopLimit;
/** Whether an order type has a stop (trigger) price (STOP, STOP_LIMIT). */
export const isStopOrdType = (ordType: OrdType) =>
  ordType === OrdType.Stop || ordType === OrdType.StopLimit;

export const TimeInForce = Object.freeze({
  Day: "DAY",
  GoodTillCancel: "GTC",
  ImmediateOrCancel: "IOC",
  FillOrKill: "FOK",
} as const);
export type TimeInForce = ValueOf<typeof TimeInForce>;
export const TIME_IN_FORCE_VALUES = values(TimeInForce);
/** Time in force a stop order may have: it waits in the OMS, so not IOC / FOK. */
export const STOP_TIME_IN_FORCE_VALUES: readonly TimeInForce[] = Object.freeze([
  TimeInForce.Day,
  TimeInForce.GoodTillCancel,
]);

/** Kind of instrument (instruments.instrumentType). */
export const InstrumentType = Object.freeze({
  Equity: "EQUITY",
  Future: "FUTURE",
} as const);
export type InstrumentType = ValueOf<typeof InstrumentType>;
export const INSTRUMENT_TYPES = values(InstrumentType);

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
  /** Futures expiry: an open position closed at the settlement price. */
  Settlement: "SETTLEMENT",
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

/** Kinds of simulator bot (bots.kind); the simulator's registry has one entry each. */
export const SimBotKind = Object.freeze({
  MarketMaker: "marketMaker",
  NoiseTaker: "noiseTaker",
  Momentum: "momentum",
  MeanReversion: "meanReversion",
  AggressiveTrader: "aggressiveTrader",
  StopLosses: "stopLosses",
  Iceberg: "iceberg",
  Informed: "informed",
} as const);
export type SimBotKind = ValueOf<typeof SimBotKind>;
export const SIM_BOT_KINDS = values(SimBotKind);

/** Starter personas of the OMS client bots (clientBots.persona). */
export const ClientPersona = Object.freeze({
  /** Large VWAPs, one side across a programme of names. */
  Pension: "pension",
  /** POV 10–20%, buying names up on the day and selling those down. */
  HedgeFund: "hedgeFund",
  /** Many short TWAPs, either side. */
  Quant: "quant",
  /** Urgent POV 25% selling (or buying back) a position. */
  Liquidation: "liquidation",
  /** Trades towards the exchange's fair value when the price lags it. */
  Informed: "informed",
} as const);
export type ClientPersona = ValueOf<typeof ClientPersona>;
export const CLIENT_PERSONAS = values(ClientPersona);

/** How a client bot picks the side of a new parent order. */
export const ClientSideMode = Object.freeze({
  Random: "random",
  /** One side (programmeSide) for every order. */
  Programme: "programme",
  /** Lean against the account's position in the name. */
  PositionReverting: "positionReverting",
  /** Buy names up on the day, sell names down. */
  Momentum: "momentum",
  /** Towards the exchange's fair value; no order without a gap. */
  Informed: "informed",
} as const);
export type ClientSideMode = ValueOf<typeof ClientSideMode>;
export const CLIENT_SIDE_MODES = values(ClientSideMode);

/** Status of a simulator scenario run (scenarioRuns.status). */
export const ScenarioStatus = Object.freeze({
  Running: "RUNNING",
  Done: "DONE",
  Stopped: "STOPPED",
  /** Live when the server stopped; its changes were reverted on restart. */
  Aborted: "ABORTED",
  Failed: "FAILED",
} as const);
export type ScenarioStatus = ValueOf<typeof ScenarioStatus>;
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
  MissingStopPrice: "MISSING_STOP_PRICE",
  /** Stop price off tick, or already reached by the market. */
  InvalidStopPrice: "INVALID_STOP_PRICE",
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

/**
 * How the OMS works a parent order. DMA sends one child straight to the
 * exchange; the others slice the order over time (see the OMS algo container).
 */
export const AlgoStrategy = Object.freeze({
  Dma: "DMA",
  Twap: "TWAP",
  Vwap: "VWAP",
  Pov: "POV",
} as const);
export type AlgoStrategy = ValueOf<typeof AlgoStrategy>;
export const ALGO_STRATEGIES = values(AlgoStrategy);

/** Bot categories driven by the exchange-sim `setBotRate` admin RPC. */
export const BotType = Object.freeze({
  MarketMaker: "MARKET_MAKER",
  Taker: "TAKER",
  All: "ALL",
} as const);
export type BotType = ValueOf<typeof BotType>;
export const BOT_TYPES = values(BotType);

/**
 * Type of an order-by-order (L3) book event in the EXCHANGE `bookEvents`
 * table. EXECUTE is reported against the resting (maker) order only; an
 * amend that loses time priority is a DELETE followed by an ADD.
 */
export const BookEventType = Object.freeze({
  Add: "ADD",
  Execute: "EXECUTE",
  Reduce: "REDUCE",
  Delete: "DELETE",
} as const);
export type BookEventType = ValueOf<typeof BookEventType>;
export const BOOK_EVENT_TYPES = values(BookEventType);

/** Type guard: `value` is one of the `allowed` enum values. */
export const isEnumValue = <T extends string>(
  allowed: readonly T[],
  value: unknown,
): value is T => typeof value === "string" && allowed.includes(value as T);
