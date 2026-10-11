import {
  type CreateOrderRequest,
  type InstrumentStatic,
  OrdType,
  type OrderReject,
  RejectReason,
  Side,
  type TradingPhase,
  validateOrder,
} from "@heswell/trading-schemas";
import type { Account } from "../reference/accounts";

/** Instrument data the risk check needs (exchange-sim InstrumentDef satisfies it). */
export interface RiskInstrument extends InstrumentStatic {
  refPrice: number;
  /** USD value of one unit of price (GBX prices are in pence). */
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
}

/** Order fields the risk check reads (a validated createOrder / amend projection). */
export type RiskOrder = Pick<
  CreateOrderRequest,
  "account" | "ric" | "side" | "ordType" | "quantity" | "price" | "timeInForce"
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

/** Price a market order is expected to execute at (far touch, else reference). */
export const expectedPrice = (
  order: Pick<RiskOrder, "side" | "ordType" | "price">,
  instrument: Pick<RiskInstrument, "refPrice">,
  market?: RiskMarket,
) => {
  if (order.ordType !== OrdType.Market && order.price) return order.price;
  const touch = order.side === Side.Buy ? market?.ask : market?.bid;
  return touch && touch > 0 ? touch : referencePrice(instrument, market);
};

const fmtUsd = (n: number) => `${Math.round(n).toLocaleString("en-US")} USD`;

/**
 * Pre-trade risk, evaluated in order (first failure wins):
 * account known / enabled, instrument known, restricted list, static order
 * validation incl. trading phase (HALTED / CLOSED), maxOrderQty,
 * maxOrderNotional, limit price collar, maxPositionNotional.
 *
 * Notionals are converted to USD with the instrument's usdPerPriceUnit; account
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
  if (invalid) return invalid;

  if (order.quantity > account.maxOrderQty) {
    return reject(
      RejectReason.ExceedsMaxQuantity,
      `quantity ${order.quantity} exceeds max ${account.maxOrderQty}`,
    );
  }
  const px = expectedPrice(order, instrument, ctx.market);
  const notionalUsd = order.quantity * px * instrument.usdPerPriceUnit;
  if (notionalUsd > account.maxOrderNotional) {
    return reject(
      RejectReason.ExceedsMaxNotional,
      `order notional ${fmtUsd(notionalUsd)} exceeds max ${fmtUsd(account.maxOrderNotional)}`,
    );
  }
  if (order.ordType === OrdType.Limit && order.price) {
    const ref = referencePrice(instrument, ctx.market);
    if (Math.abs(order.price / ref - 1) > ctx.collarPct + 1e-9) {
      return reject(
        RejectReason.PriceOutsideCollar,
        `price ${order.price} is more than ${ctx.collarPct * 100}% from reference ${ref}`,
      );
    }
  }
  const sign = order.side === Side.Buy ? 1 : -1;
  const working = sign > 0 ? ctx.workingBuyQty : ctx.workingSellQty;
  const projected = Math.abs(
    ctx.positionQty + sign * (working + order.quantity),
  );
  const positionUsd =
    projected *
    referencePrice(instrument, ctx.market) *
    instrument.usdPerPriceUnit;
  if (
    projected > Math.abs(ctx.positionQty) &&
    positionUsd > account.maxPositionNotional
  ) {
    return reject(
      RejectReason.ExceedsMaxNotional,
      `projected position ${fmtUsd(positionUsd)} exceeds max ${fmtUsd(account.maxPositionNotional)}`,
    );
  }
};
