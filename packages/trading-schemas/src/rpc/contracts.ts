import type {
  RpcResultError,
  RpcResultSuccess,
  ViewportRpcContext,
} from "@vuu-ui/vuu-protocol-types";
import {
  BOT_TYPES,
  type OrdStatus,
  ORD_TYPES,
  REJECT_REASONS,
  RejectReason,
  SIDES,
  TIME_IN_FORCE_VALUES,
  TimeInForce,
} from "../domain/enums";
import {
  boolean,
  type Infer,
  number,
  object,
  oneOf,
  optional,
  string,
  type ValidationResult,
} from "./validate";

/**
 * RPC contracts. All trading RPCs are sent as RPC_REQUEST with
 * VIEWPORT_CONTEXT (any viewport on a table of the target module) and are
 * registered server-side with DefaultRpcHandler.registerRpc.
 *
 * Params are flat (Vuu restricts RPC params to string | number | boolean).
 * Success: SUCCESS_RESULT with the typed `data` below.
 * Failure: ERROR_RESULT whose errorMessage is `"<RejectReason>: <text>"`
 * (see formatRpcError / parseRpcError).
 */
export const RpcName = Object.freeze({
  CreateOrder: "createOrder",
  AmendOrder: "amendOrder",
  CancelOrder: "cancelOrder",
  CancelAll: "cancelAll",
  SetVolatility: "setVolatility",
  HaltInstrument: "haltInstrument",
  ResumeInstrument: "resumeInstrument",
  SetBotRate: "setBotRate",
} as const);
export type RpcName = (typeof RpcName)[keyof typeof RpcName];

export const OMS_RPC_NAMES = Object.freeze([
  RpcName.CreateOrder,
  RpcName.AmendOrder,
  RpcName.CancelOrder,
  RpcName.CancelAll,
] as const);
export const EXCHANGE_ADMIN_RPC_NAMES = Object.freeze([
  RpcName.SetVolatility,
  RpcName.HaltInstrument,
  RpcName.ResumeInstrument,
  RpcName.SetBotRate,
] as const);

const id = string({ maxLength: 64 });
const ric = string({ maxLength: 32 });
const positiveQty = number({ greaterThan: 0 });
const positivePrice = number({ greaterThan: 0 });

// ---------------------------------------------------------------- OMS

export const createOrderParams = object({
  /** Client-assigned id, echoed back; must be unique per trader if supplied. */
  clOrdId: optional(id),
  account: id,
  ric,
  side: oneOf(SIDES),
  ordType: oneOf(ORD_TYPES),
  quantity: positiveQty,
  /** Required for LIMIT, must be omitted / 0 for MARKET. */
  price: optional(number({ min: 0 })),
  timeInForce: optional(oneOf(TIME_IN_FORCE_VALUES)),
  /** Reserved for STOP / STOP_LIMIT. */
  stopPrice: optional(positivePrice),
});
export type CreateOrderRequest = Infer<typeof createOrderParams>;
export interface CreateOrderResponse {
  orderId: string;
  clOrdId?: string;
  status: OrdStatus;
}

/** At least one of quantity / price must be supplied. Quantity is the new total. */
export const amendOrderParams = object({
  orderId: id,
  quantity: optional(positiveQty),
  price: optional(positivePrice),
});
export type AmendOrderRequest = Infer<typeof amendOrderParams>;
export interface AmendOrderResponse {
  orderId: string;
  status: OrdStatus;
}

export const cancelOrderParams = object({
  orderId: id,
});
export type CancelOrderRequest = Infer<typeof cancelOrderParams>;
export interface CancelOrderResponse {
  orderId: string;
  status: OrdStatus;
}

/** Filter fields are ANDed; an empty filter cancels all of the caller's working orders. */
export const cancelAllParams = object({
  account: optional(id),
  ric: optional(ric),
  side: optional(oneOf(SIDES)),
});
export type CancelAllRequest = Infer<typeof cancelAllParams>;
export interface CancelAllResponse {
  /** Orders for which a cancel was sent. */
  orderIds: string[];
}

// ---------------------------------------------------------------- EXCHANGE admin

/** Omitting ric applies to all simulated instruments. */
export const setVolatilityParams = object({
  ric: optional(ric),
  /** Annualised volatility, e.g. 0.25 = 25%. */
  volatility: number({ min: 0, max: 10 }),
});
export type SetVolatilityRequest = Infer<typeof setVolatilityParams>;

export const haltInstrumentParams = object({
  ric,
  reason: optional(string({ maxLength: 256 })),
});
export type HaltInstrumentRequest = Infer<typeof haltInstrumentParams>;

export const resumeInstrumentParams = object({
  ric,
  /** Re-open via an auction uncross rather than straight to continuous. */
  auction: optional(boolean()),
});
export type ResumeInstrumentRequest = Infer<typeof resumeInstrumentParams>;

/** Omitting ric applies to all simulated instruments; bot defaults to ALL. */
export const setBotRateParams = object({
  ric: optional(ric),
  bot: optional(oneOf(BOT_TYPES)),
  /** Target events per second per instrument (0 pauses the bots). */
  rate: number({ min: 0, max: 100_000 }),
});
export type SetBotRateRequest = Infer<typeof setBotRateParams>;

export interface AdminRpcResponse {
  /** Instruments affected. */
  rics: string[];
}

// ---------------------------------------------------------------- typing

export interface RpcContracts {
  createOrder: [CreateOrderRequest, CreateOrderResponse];
  amendOrder: [AmendOrderRequest, AmendOrderResponse];
  cancelOrder: [CancelOrderRequest, CancelOrderResponse];
  cancelAll: [CancelAllRequest, CancelAllResponse];
  setVolatility: [SetVolatilityRequest, AdminRpcResponse];
  haltInstrument: [HaltInstrumentRequest, AdminRpcResponse];
  resumeInstrument: [ResumeInstrumentRequest, AdminRpcResponse];
  setBotRate: [SetBotRateRequest, AdminRpcResponse];
}
export type RpcRequestParams<N extends RpcName> = RpcContracts[N][0];
export type RpcResponseData<N extends RpcName> = RpcContracts[N][1];

export interface TradingRpcRequest<N extends RpcName = RpcName> {
  type: "RPC_REQUEST";
  context: ViewportRpcContext;
  rpcName: N;
  params: RpcRequestParams<N>;
}

export type TradingRpcSuccess<N extends RpcName> = RpcResultSuccess & {
  data: RpcResponseData<N>;
};
export type TradingRpcResult<N extends RpcName> =
  | TradingRpcSuccess<N>
  | RpcResultError;

/** Build a client RPC_REQUEST message (send via DataSource.rpcRequest). */
export const tradingRpcRequest = <N extends RpcName>(
  rpcName: N,
  params: RpcRequestParams<N>,
  viewPortId: string,
): TradingRpcRequest<N> => ({
  type: "RPC_REQUEST",
  context: { type: "VIEWPORT_CONTEXT", viewPortId },
  rpcName,
  params,
});

export const rpcSuccess = <N extends RpcName>(
  _rpcName: N,
  data: RpcResponseData<N>,
): TradingRpcSuccess<N> => ({ type: "SUCCESS_RESULT", data });

export const formatRpcError = (reason: RejectReason, text?: string) =>
  text ? `${reason}: ${text}` : reason;

export const rpcError = (
  reason: RejectReason,
  text?: string,
): RpcResultError => ({
  type: "ERROR_RESULT",
  errorMessage: formatRpcError(reason, text),
});

/** Split an ERROR_RESULT message into reason code + text. */
export const parseRpcError = (
  errorMessage: string,
): { reason: RejectReason; text: string } => {
  const i = errorMessage.indexOf(":");
  const code = (i === -1 ? errorMessage : errorMessage.slice(0, i)).trim();
  if ((REJECT_REASONS as readonly string[]).includes(code)) {
    return {
      reason: code as RejectReason,
      text: i === -1 ? "" : errorMessage.slice(i + 1).trim(),
    };
  }
  return { reason: RejectReason.InternalError, text: errorMessage };
};

// ---------------------------------------------------------------- validation

const validators = {
  createOrder: createOrderParams,
  amendOrder: amendOrderParams,
  cancelOrder: cancelOrderParams,
  cancelAll: cancelAllParams,
  setVolatility: setVolatilityParams,
  haltInstrument: haltInstrumentParams,
  resumeInstrument: resumeInstrumentParams,
  setBotRate: setBotRateParams,
} as const;

/**
 * Structural validation of RPC params (types, enums, required fields).
 * createOrder defaults timeInForce to DAY. Business rules against the
 * instrument (tick/lot, phase) are in validateOrder.
 */
export function validateRpcParams<N extends RpcName>(
  rpcName: N,
  params: unknown,
): ValidationResult<RpcRequestParams<N>> {
  const validator = validators[rpcName];
  if (!validator) {
    return { ok: false, errors: [`unknown rpc ${rpcName}`] };
  }
  const result = validator(params, "params") as ValidationResult<
    RpcRequestParams<N>
  >;
  if (!result.ok) return result;
  if (rpcName === RpcName.CreateOrder) {
    const v = result.value as CreateOrderRequest;
    v.timeInForce ??= TimeInForce.Day;
  }
  if (rpcName === RpcName.AmendOrder) {
    const v = result.value as AmendOrderRequest;
    if (v.quantity === undefined && v.price === undefined) {
      return {
        ok: false,
        errors: ["params: one of quantity or price is required"],
      };
    }
  }
  return result;
}
