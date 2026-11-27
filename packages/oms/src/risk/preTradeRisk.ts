import {
  collarWidth,
  type CreateOrderRequest,
  EntryRiskCode,
  InstrumentType,
  isOutsideCollar,
  type InstrumentStatic,
  isStopOrdType,
  OrdType,
  type OrderReject,
  RejectReason,
  Side,
  type TradingPhase,
  usdPerUnit,
  validateOrder,
  validateStopTrigger,
} from "@heswell/trading-schemas";
import type { OptionGreeksQuote } from "../engine/gateway";
import { type OrderLimits, orderLimitsOf } from "../limits/LimitBook";
import type { Account } from "../reference/accounts";

/** Instrument data the risk check needs (exchange-sim InstrumentDef satisfies it). */
export interface RiskInstrument extends InstrumentStatic {
  refPrice: number;
  /** USD value of one unit of the price currency (GBX prices are in pence). */
  usdPerPriceUnit: number;
}

export interface RiskMarket {
  bid: number;
  ask: number;
  last: number;
}

export interface RiskContext {
  account: Account | undefined;
  instrument: RiskInstrument | undefined;
  phase: TradingPhase;
  market: RiskMarket | undefined;
  restricted: ReadonlySet<string>;
  collarPct: number;
  /** Current net position of account|ric. */
  positionQty: number;
  /** Leaves quantity of the account's working orders in this ric, by side. */
  workingBuyQty: number;
  workingSellQty: number;
  /**
   * USD delta of one unit bought (see deltaUsdPerUnit); absent = no delta
   * check.
   */
  deltaUsdPerUnit?: number;
  /** The account's net delta (USD) on the instrument's underlying now. */
  underlyingDeltaUsd?: number;
  /** A quote-only option: the nearest liquid strike, to point the user at. */
  nearestLiquid?: string;
  /**
   * The limits that apply to this account and instrument (the engine's
   * LimitBook); absent = the account's own fields.
   */
  limits?: OrderLimits;
}

/** Order fields the risk check reads (a validated createOrder / amend projection). */
export type RiskOrder = Pick<
  CreateOrderRequest,
  | "account"
  | "ric"
  | "side"
  | "ordType"
  | "quantity"
  | "price"
  | "stopPrice"
  | "timeInForce"
>;

const reject = (reason: RejectReason, text: string): OrderReject => ({
  reason,
  text,
});

/** Reference price for collars / notional: last, else mid, else refPrice. */
export const referencePrice = (
  instrument: Pick<RiskInstrument, "refPrice">,
  market?: RiskMarket,
) => {
  if (market?.last && market.last > 0) return market.last;
  if (market && market.bid > 0 && market.ask > 0) {
    return (market.bid + market.ask) / 2;
  }
  return instrument.refPrice;
};

/**
 * Price an order is expected to execute at: its limit, a STOP's stop price,
 * else (market) the far touch, else the reference price.
 */
export const expectedPrice = (
  order: Pick<RiskOrder, "side" | "ordType" | "price" | "stopPrice">,
  instrument: Pick<RiskInstrument, "refPrice">,
  market?: RiskMarket,
) => {
  if (order.ordType !== OrdType.Market && order.price) return order.price;
  if (order.ordType === OrdType.Stop && order.stopPrice) return order.stopPrice;
  const touch = order.side === Side.Buy ? market?.ask : market?.bid;
  return touch && touch > 0 ? touch : referencePrice(instrument, market);
};

/**
 * USD delta of one unit of quantity bought: an option's model delta x the
 * forward x the multiplier (undefined without Greeks); anything else is
 * delta one, the reference price x the multiplier.
 */
export const deltaUsdPerUnit = (
  instrument: RiskInstrument,
  market: RiskMarket | undefined,
  greeks: OptionGreeksQuote | undefined,
): number | undefined => {
  if (instrument.instrumentType === InstrumentType.Option) {
    return greeks
      ? greeks.delta * greeks.forward * usdPerUnit(instrument)
      : undefined;
  }
  return referencePrice(instrument, market) * usdPerUnit(instrument);
};

const fmtUsd = (n: number) => `${Math.round(n).toLocaleString("en-US")} USD`;

/**
 * Pre-trade risk, evaluated in order (first failure wins):
 * account known / enabled, instrument known, restricted list, static order
 * validation incl. trading phase (HALTED / CLOSED), stop not already
 * reached, maxOrderQty, maxOrderNotional, limit price collar (LIMIT only:
 * stops may legitimately sit far from the market; wider for options, see
 * collarWidth), maxPositionNotional, maxDeltaUsd.
 *
 * Notionals are converted to USD with usdPerUnit (currency x contract
 * multiplier); account
 * limits are in USD. The position check is worst case: current net position
 * plus all same-side working leaves plus this order.
 */
export const checkPreTradeRisk = (
  order: RiskOrder,
  ctx: RiskContext,
): OrderReject | undefined => {
  const { account, instrument } = ctx;
  if (!account) {
    return reject(
      RejectReason.UnknownAccount,
      `unknown account ${order.account}`,
    );
  }
  if (!account.enabled) {
    return reject(
      RejectReason.AccountDisabled,
      `account ${account.account} is disabled`,
    );
  }
  if (!instrument) {
    return reject(
      RejectReason.UnknownInstrument,
      `unknown instrument ${order.ric}`,
    );
  }
  if (ctx.restricted.has(order.ric)) {
    return reject(
      RejectReason.RestrictedInstrument,
      `${order.ric} is on the restricted list`,
    );
  }
  const invalid = validateOrder(order, instrument, ctx.phase);
  if (invalid) return withNearestLiquid(invalid, instrument, ctx.nearestLiquid);
  if (isStopOrdType(order.ordType) && order.stopPrice) {
    const reached = validateStopTrigger(
      order.side,
      order.stopPrice,
      referencePrice(instrument, ctx.market),
    );
    if (reached) return reached;
  }

  return riskLimitBreaches(order, account, instrument, ctx)[0];
};

/**
 * A quote-only option's reject, pointing at the nearest liquid strike
 * (`nearest`) when there is one.
 */
export const withNearestLiquid = (
  reject: OrderReject,
  instrument: Pick<RiskInstrument, "liquid">,
  nearest: string | undefined,
): OrderReject =>
  reject.reason === RejectReason.RestrictedInstrument &&
  instrument.liquid === false &&
  nearest
    ? { ...reject, text: `${reject.text}, e.g. ${nearest}` }
    : reject;

/** A broken account limit or the collar (see riskLimitBreaches). */
export interface RiskBreach extends OrderReject {
  code: EntryRiskCode;
}

/**
 * The account limits and the collar an order breaks, in checkPreTradeRisk's
 * order: maxOrderQty, maxOrderNotional (the premium for an option), the
 * limit price collar (LIMIT only), maxPositionNotional, then maxDeltaUsd:
 * the account's net delta on the underlying (a stock, its futures and
 * options net), checked only when the order adds to it. The order ticket
 * shows them all; createOrder rejects on the first.
 */
export const riskLimitBreaches = (
  order: RiskOrder,
  account: Account,
  instrument: RiskInstrument,
  ctx: Pick<
    RiskContext,
    | "market"
    | "collarPct"
    | "positionQty"
    | "workingBuyQty"
    | "workingSellQty"
    | "deltaUsdPerUnit"
    | "underlyingDeltaUsd"
    | "limits"
  >,
): RiskBreach[] => {
  const breaches: RiskBreach[] = [];
  const limits = ctx.limits ?? orderLimitsOf(account);
  if (order.quantity > limits.maxOrderQty) {
    breaches.push({
      code: EntryRiskCode.MaxOrderQty,
      reason: RejectReason.ExceedsMaxQuantity,
      text: `quantity ${order.quantity} exceeds max ${limits.maxOrderQty}`,
    });
  }
  const px = expectedPrice(order, instrument, ctx.market);
  const notionalUsd = order.quantity * px * usdPerUnit(instrument);
  if (notionalUsd > limits.maxOrderNotional) {
    breaches.push({
      code: EntryRiskCode.MaxOrderNotional,
      reason: RejectReason.ExceedsMaxNotional,
      text: `order notional ${fmtUsd(notionalUsd)} exceeds max ${fmtUsd(limits.maxOrderNotional)}`,
    });
  }
  if (order.ordType === OrdType.Limit && order.price) {
    const ref = referencePrice(instrument, ctx.market);
    if (isOutsideCollar(instrument, order.price, ref, ctx.collarPct)) {
      const width = collarWidth(instrument, ref, ctx.collarPct);
      breaches.push({
        code: EntryRiskCode.Collar,
        reason: RejectReason.PriceOutsideCollar,
        text:
          instrument.instrumentType === InstrumentType.Option
            ? `price ${order.price} is more than ${+width.toFixed(6)} from reference ${ref}`
            : `price ${order.price} is more than ${ctx.collarPct * 100}% from reference ${ref}`,
      });
    }
  }
  const sign = order.side === Side.Buy ? 1 : -1;
  const working = sign > 0 ? ctx.workingBuyQty : ctx.workingSellQty;
  const projected = Math.abs(
    ctx.positionQty + sign * (working + order.quantity),
  );
  const positionUsd =
    projected * referencePrice(instrument, ctx.market) * usdPerUnit(instrument);
  if (
    projected > Math.abs(ctx.positionQty) &&
    positionUsd > limits.maxPositionNotional
  ) {
    breaches.push({
      code: EntryRiskCode.MaxPositionNotional,
      reason: RejectReason.ExceedsMaxNotional,
      text: `projected position ${fmtUsd(positionUsd)} exceeds max ${fmtUsd(limits.maxPositionNotional)}`,
    });
  }
  if (
    Number.isFinite(limits.maxDeltaUsd) &&
    ctx.deltaUsdPerUnit !== undefined
  ) {
    const current = ctx.underlyingDeltaUsd ?? 0;
    const delta = current + sign * order.quantity * ctx.deltaUsdPerUnit;
    if (
      Math.abs(delta) > Math.abs(current) &&
      Math.abs(delta) > limits.maxDeltaUsd
    ) {
      breaches.push({
        code: EntryRiskCode.MaxDelta,
        reason: RejectReason.ExceedsMaxDelta,
        text: `net delta on ${instrument.underlying || instrument.ric} ${fmtUsd(delta)} exceeds max ${fmtUsd(limits.maxDeltaUsd)}`,
      });
    }
  }
  return breaches;
};
