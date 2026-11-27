import {
  collarWidth,
  type CreateOrderRequest,
  EntryRiskCode,
  InstrumentType,
  type LimitCheckLine,
  LimitMetric,
  LimitOverrideReason,
  LimitState,
  limitState,
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
import {
  type LimitLevels,
  type OrderLimits,
  orderLimitsOf,
} from "../limits/LimitBook";
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
  /**
   * Limits on totals, one per entity (the account, its desk, the firm) that
   * sets one: gross position notional and, for a new order, order rate.
   */
  totals?: TotalLimits;
  /** The entity (the account, its desk or the firm) whose kill switch is on. */
  killedBy?: string;
}

export interface TotalLimits {
  /** otherUsd: the entity's gross USD notional less this account and RIC. */
  gross: (LimitLevels & { otherUsd: number })[];
  /** count: the entity's orders in the last second. */
  rate: (LimitLevels & { count: number })[];
}

/** Why an order over a limit (a soft breach) is sent anyway. */
export interface LimitOverride {
  reason: LimitOverrideReason;
  note?: string;
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

const reject_ = (reason: RejectReason, text: string): OrderReject => ({
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
 * account known / enabled, kill switch off, instrument known, restricted list, static order
 * validation incl. trading phase (HALTED / CLOSED), stop not already
 * reached, then the limits and the collar (riskLimitBreaches; LIMIT only:
 * stops may legitimately sit far from the market; wider for options, see
 * collarWidth). A limit at its hard level always rejects; one over the
 * limit (a soft breach) rejects unless `override` gives a reason.
 *
 * Notionals are converted to USD with usdPerUnit (currency x contract
 * multiplier); account
 * limits are in USD. The position check is worst case: current net position
 * plus all same-side working leaves plus this order.
 */
export const checkPreTradeRisk = (
  order: RiskOrder,
  ctx: RiskContext,
  override?: LimitOverride,
): OrderReject | undefined => preTradeRisk(order, ctx, override).reject;

/**
 * checkPreTradeRisk, with the limits an override let through: an order over
 * a limit (a soft breach) passes with an override, and those limits are
 * returned in `overridden`; a hard breach, the collar and the order rate
 * always reject. An OTHER override needs a note.
 */
export const preTradeRisk = (
  order: RiskOrder,
  ctx: RiskContext,
  override?: LimitOverride,
): { reject?: OrderReject; overridden: LimitCheck[] } => {
  const reject = staticReject(order, ctx);
  if (reject || !ctx.account || !ctx.instrument) {
    return { reject, overridden: [] };
  }
  const breaches = riskLimitBreaches(order, ctx.account, ctx.instrument, ctx);
  const asReject = ({ reason, text }: RiskBreach) => ({ reason, text });
  const hard = breaches.find((b) => b.level === "hard");
  if (hard) return { reject: asReject(hard), overridden: [] };
  if (breaches.length === 0) return { overridden: [] };
  if (!override) return { reject: asReject(breaches[0]), overridden: [] };
  if (override.reason === LimitOverrideReason.Other && !override.note?.trim()) {
    return {
      reject: reject_(
        RejectReason.InvalidRequest,
        "an override for another reason needs a note",
      ),
      overridden: [],
    };
  }
  return {
    overridden: breaches.flatMap((b) => (b.check ? [b.check] : [])),
  };
};

/** The checks before the limits: account, kill switch, instrument, order. */
const staticReject = (
  order: RiskOrder,
  ctx: RiskContext,
): OrderReject | undefined => {
  const { account, instrument } = ctx;
  if (!account) {
    return reject_(
      RejectReason.UnknownAccount,
      `unknown account ${order.account}`,
    );
  }
  if (!account.enabled) {
    return reject_(
      RejectReason.AccountDisabled,
      `account ${account.account} is disabled`,
    );
  }
  if (ctx.killedBy) {
    return reject_(
      RejectReason.KillSwitch,
      ctx.killedBy === account.account
        ? `trading is stopped for ${account.account}`
        : `trading is stopped for ${ctx.killedBy} (${account.account})`,
    );
  }
  if (!instrument) {
    return reject_(
      RejectReason.UnknownInstrument,
      `unknown instrument ${order.ric}`,
    );
  }
  if (ctx.restricted.has(order.ric)) {
    return reject_(
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
  return undefined;
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

/** One limit an order is checked against, with the reject it would cause. */
export interface LimitCheck extends LimitCheckLine {
  code: EntryRiskCode;
  reason: RejectReason;
  /** Why the order breaks the limit (or would, were it to breach). */
  text: string;
}

/** A check as the ticket reads it, without the reject it would cause. */
export const limitCheckLine = ({
  code: _code,
  reason: _reason,
  text: _text,
  ...line
}: LimitCheck): LimitCheckLine => line;

/**
 * A broken limit or the collar (see riskLimitBreaches). level: "soft" = over
 * the limit, which an override lets through; "hard" = at the hard limit, the
 * collar or the order rate, which nothing does.
 */
export interface RiskBreach extends OrderReject {
  code: EntryRiskCode;
  level: "soft" | "hard";
  /** The limit broken; absent for the collar. */
  check?: LimitCheck;
}

type LimitContext = Pick<
  RiskContext,
  | "market"
  | "collarPct"
  | "positionQty"
  | "workingBuyQty"
  | "workingSellQty"
  | "deltaUsdPerUnit"
  | "underlyingDeltaUsd"
  | "limits"
  | "totals"
>;

/** The largest whole quantity q with base + q * perUnit at or under hard. */
const maxQtyUnder = (hard: number, base: number, perUnit: number) =>
  perUnit > 0
    ? Math.max(0, Math.floor((hard - base) / perUnit + 1e-9))
    : undefined;

/**
 * Every limit an order is checked against, in checkPreTradeRisk's order:
 * order quantity, order notional (the premium for an option), position
 * notional (worst case: the position plus same-side working orders and this
 * order), gross position notional of the account, its desk and the Firm
 * (each that sets one), net delta on the underlying (a stock, its futures
 * and options net), then order rate. Position, gross and delta breach only
 * when the order adds to them. Each line carries the usage before and after
 * and the largest quantity that stays under the hard limit; the order
 * ticket shows them (the orderEntry limitCheck column, checkLimits).
 */
export const limitChecks = (
  order: RiskOrder,
  account: Account,
  instrument: RiskInstrument,
  ctx: LimitContext,
): LimitCheck[] => {
  const checks: LimitCheck[] = [];
  const limits = ctx.limits ?? orderLimitsOf(account);
  const add = (
    levels: LimitLevels,
    metric: LimitMetric,
    ric: string,
    before: number,
    after: number,
    adds: boolean,
    maxQty: number | undefined,
    code: EntryRiskCode,
    reason: RejectReason,
    text: (max: string) => string,
    fmt: (n: number) => string,
  ) => {
    const state = limitState(after, levels);
    const breach =
      adds &&
      (state === LimitState.SoftBreach || state === LimitState.HardBreach);
    checks.push({
      limitKey: levels.limitKey,
      entityId: levels.entityId,
      metric,
      ric,
      before,
      after,
      warning: levels.warning,
      soft: levels.soft,
      hard: levels.hard,
      state,
      breach,
      ...(maxQty !== undefined && Number.isFinite(maxQty) ? { maxQty } : {}),
      code,
      reason,
      text:
        state === LimitState.HardBreach && levels.hard > levels.soft
          ? text(`hard limit ${fmt(levels.hard)}`)
          : text(`max ${fmt(levels.soft)}`),
    });
  };
  const qtyText = (n: number) => `${n}`;

  if (limits.orderQty) {
    add(
      limits.orderQty,
      LimitMetric.OrderQty,
      "",
      0,
      order.quantity,
      true,
      maxQtyUnder(limits.orderQty.hard, 0, 1),
      EntryRiskCode.MaxOrderQty,
      RejectReason.ExceedsMaxQuantity,
      (max) => `quantity ${order.quantity} exceeds ${max}`,
      qtyText,
    );
  }
  const px = expectedPrice(order, instrument, ctx.market);
  const unitUsd = usdPerUnit(instrument);
  const notionalUsd = order.quantity * px * unitUsd;
  if (limits.orderNotional) {
    add(
      limits.orderNotional,
      LimitMetric.OrderNotional,
      "",
      0,
      notionalUsd,
      true,
      maxQtyUnder(limits.orderNotional.hard, 0, px * unitUsd),
      EntryRiskCode.MaxOrderNotional,
      RejectReason.ExceedsMaxNotional,
      (max) => `order notional ${fmtUsd(notionalUsd)} exceeds ${max}`,
      fmtUsd,
    );
  }

  const sign = order.side === Side.Buy ? 1 : -1;
  const working = sign > 0 ? ctx.workingBuyQty : ctx.workingSellQty;
  // the position with same-side working orders, signed in the order's side
  const base = sign * ctx.positionQty + working;
  const projected = Math.abs(base + order.quantity);
  const adds = projected > Math.abs(ctx.positionQty);
  const refUsd = referencePrice(instrument, ctx.market) * unitUsd;
  const beforeUsd = Math.abs(base) * refUsd;
  const positionUsd = projected * refUsd;
  if (limits.positionNotional) {
    add(
      limits.positionNotional,
      LimitMetric.PositionNotional,
      order.ric,
      beforeUsd,
      positionUsd,
      adds,
      maxQtyUnder(limits.positionNotional.hard, base * refUsd, refUsd),
      EntryRiskCode.MaxPositionNotional,
      RejectReason.ExceedsMaxNotional,
      (max) => `projected position ${fmtUsd(positionUsd)} exceeds ${max}`,
      fmtUsd,
    );
  }
  for (const gross of ctx.totals?.gross ?? []) {
    const grossUsd = gross.otherUsd + positionUsd;
    add(
      gross,
      LimitMetric.GrossPositionNotional,
      "",
      gross.otherUsd + beforeUsd,
      grossUsd,
      adds,
      maxQtyUnder(gross.hard, gross.otherUsd + base * refUsd, refUsd),
      EntryRiskCode.MaxGrossNotional,
      RejectReason.ExceedsMaxGrossNotional,
      (max) =>
        `gross position notional of ${gross.entityId} ${fmtUsd(grossUsd)} exceeds ${max}`,
      fmtUsd,
    );
  }
  if (limits.netDelta && ctx.deltaUsdPerUnit !== undefined) {
    const current = ctx.underlyingDeltaUsd ?? 0;
    // the delta this order adds per unit, and the current delta in its sign
    const perUnit = sign * ctx.deltaUsdPerUnit;
    const delta = current + order.quantity * perUnit;
    const along = perUnit >= 0 ? current : -current;
    add(
      limits.netDelta,
      LimitMetric.NetDelta,
      instrument.underlying || instrument.ric,
      Math.abs(current),
      Math.abs(delta),
      Math.abs(delta) > Math.abs(current),
      maxQtyUnder(limits.netDelta.hard, along, Math.abs(perUnit)),
      EntryRiskCode.MaxDelta,
      RejectReason.ExceedsMaxDelta,
      (max) =>
        `net delta on ${instrument.underlying || instrument.ric} ${fmtUsd(delta)} exceeds ${max}`,
      fmtUsd,
    );
  }
  for (const rate of ctx.totals?.rate ?? []) {
    // no margin over the order rate: its hard limit is the limit
    add(
      { ...rate, hard: rate.soft },
      LimitMetric.OrderRate,
      "",
      rate.count,
      rate.count + 1,
      true,
      undefined,
      EntryRiskCode.OrderRate,
      RejectReason.ExceedsOrderRate,
      () =>
        `${rate.entityId} has sent ${rate.count} orders in the last second, max ${rate.soft}`,
      qtyText,
    );
  }
  return checks;
};

/**
 * The limits and the collar an order breaks, in checkPreTradeRisk's order
 * (see limitChecks), the collar (LIMIT only) after order notional. Only the
 * first gross and the first order rate breach are listed. The order ticket
 * shows them all; createOrder rejects on the first hard one, or the first
 * one without an override.
 */
export const riskLimitBreaches = (
  order: RiskOrder,
  account: Account,
  instrument: RiskInstrument,
  ctx: LimitContext,
): RiskBreach[] => {
  const breaches: RiskBreach[] = [];
  const checks = limitChecks(order, account, instrument, ctx);
  const breach = (check: LimitCheck): RiskBreach => ({
    code: check.code,
    reason: check.reason,
    text: check.text,
    level: check.state === LimitState.HardBreach ? "hard" : "soft",
    check,
  });
  const perOrder = (c: LimitCheck) =>
    c.metric === LimitMetric.OrderQty || c.metric === LimitMetric.OrderNotional;
  for (const check of checks) {
    if (check.breach && perOrder(check)) breaches.push(breach(check));
  }
  if (order.ordType === OrdType.Limit && order.price) {
    const ref = referencePrice(instrument, ctx.market);
    if (isOutsideCollar(instrument, order.price, ref, ctx.collarPct)) {
      const width = collarWidth(instrument, ref, ctx.collarPct);
      breaches.push({
        code: EntryRiskCode.Collar,
        reason: RejectReason.PriceOutsideCollar,
        level: "hard",
        text:
          instrument.instrumentType === InstrumentType.Option
            ? `price ${order.price} is more than ${+width.toFixed(6)} from reference ${ref}`
            : `price ${order.price} is more than ${ctx.collarPct * 100}% from reference ${ref}`,
      });
    }
  }
  const listed = new Set<LimitMetric>();
  for (const check of checks) {
    if (!check.breach || perOrder(check)) continue;
    const once =
      check.metric === LimitMetric.GrossPositionNotional ||
      check.metric === LimitMetric.OrderRate;
    if (once && listed.has(check.metric)) continue;
    listed.add(check.metric);
    breaches.push(breach(check));
  }
  return breaches;
};
