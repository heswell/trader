import {
  contractMultiplierOf,
  type AlgoParamDefinition,
  ALGO_STRATEGY_DEFINITIONS,
  ALGO_STRATEGY_GROUPS,
  AlgoStrategy,
  type AlgoStrategyDefinition,
  algoStrategyDefinition,
  type CreateOrderRequest,
  InstrumentType,
  isPricedOrdType,
  isStopOrdType,
  OrdType,
  RejectReason,
  STOP_TIME_IN_FORCE_VALUES,
  SUPPORTED_ORD_TYPES,
  Side,
  roundToTick,
  stepTicks,
  type TickSchedule,
  TimeInForce,
  TradingPhase,
  tickScheduleOf,
  validateOrder,
  validateRpcParams,
  validateStopTrigger,
} from "@heswell/trading-schemas";
import { priceDecimals } from "../../utils/formatting";

/**
 * Instrument data the ticket works with: static (instruments) plus the live
 * prices of the instrumentPrices join. Everything but `ric` is optional while
 * it loads.
 */
export interface OrderTicketInstrument {
  ric: string;
  description?: string;
  currency?: string;
  exchange?: string;
  tickSize?: number;
  tickBands?: string;
  lotSize?: number;
  priceDecimals?: number;
  /** EQUITY | FUTURE | INDEX (absent = equity); an index is not tradeable. */
  instrumentType?: string;
  /** Value per unit of quantity per unit of price (futures); 1 when absent. */
  contractMultiplier?: number;
  refPrice?: number;
  bid?: number;
  ask?: number;
  bidSize?: number;
  askSize?: number;
  last?: number;
  close?: number;
  change?: number;
  changePct?: number;
  phase?: string;
}

/** An `accounts` row (limits are in USD). */
export interface OrderTicketAccount {
  account: string;
  name?: string;
  desk?: string;
  owner?: string;
  currency?: string;
  maxOrderQty?: number;
  maxOrderNotional?: number;
  maxPositionNotional?: number;
  enabled?: boolean;
}

/** The editable state of the ticket. Quantity and prices are input text. */
export interface OrderDraft {
  ric?: string;
  side: Side;
  ordType: OrdType;
  timeInForce: TimeInForce;
  quantity: string;
  /** Limit price (LIMIT, STOP_LIMIT). */
  price: string;
  /** Stop (trigger) price (STOP, STOP_LIMIT). */
  stopPrice: string;
  account?: string;
  /** How the OMS works the order; undefined = DMA. */
  strategy?: AlgoStrategy;
  /**
   * The strategy's parameters as input text, by createOrder field (see the
   * strategy definitions). Empty = the OMS default.
   */
  algoParams: Readonly<Partial<Record<AlgoParamKey, string>>>;
}

export type AlgoParamKey = AlgoParamDefinition["key"];

export type OrderDraftField =
  | "ric"
  | "side"
  | "ordType"
  | "timeInForce"
  | "quantity"
  | "price"
  | "stopPrice"
  | "account"
  | "strategy"
  | AlgoParamKey;

export type OrderDraftErrors = Partial<
  Record<OrderDraftField | "form", string>
>;

/** Order types the ticket offers, in display order. */
export const ORDER_TICKET_ORD_TYPES: readonly OrdType[] = [
  OrdType.Limit,
  OrdType.Market,
  OrdType.Stop,
  OrdType.StopLimit,
].filter((t) => SUPPORTED_ORD_TYPES.includes(t));

/** Display name of an order type ("Stop limit"). */
export const ORD_TYPE_LABEL: Readonly<Record<string, string>> = Object.freeze({
  [OrdType.Limit]: "Limit",
  [OrdType.Market]: "Market",
  [OrdType.Stop]: "Stop",
  [OrdType.StopLimit]: "Stop limit",
});
export const ORDER_TICKET_TIFS: readonly TimeInForce[] = [
  TimeInForce.Day,
  TimeInForce.ImmediateOrCancel,
  TimeInForce.FillOrKill,
  TimeInForce.GoodTillCancel,
];

/** Strategies offered on the ticket, in display order. */
export const ORDER_TICKET_STRATEGIES: readonly AlgoStrategy[] =
  ALGO_STRATEGY_DEFINITIONS.map((d) => d.id);

/** Whether the strategy slices the order over time (anything but DMA). */
export const isAlgoStrategy = (strategy: AlgoStrategy | undefined) =>
  strategy !== undefined && strategy !== AlgoStrategy.Dma;

/**
 * Stop orders are worked by the OMS as DMA only: a strategy other than DMA
 * can't be combined with STOP / STOP_LIMIT.
 */
export const isStrategyAllowed = (
  ordType: OrdType,
  strategy: AlgoStrategy | undefined,
) => !(isStopOrdType(ordType) && isAlgoStrategy(strategy));

/**
 * The order type an algo strategy turns a stop into: STOP → MARKET,
 * STOP_LIMIT → LIMIT (other types unchanged).
 */
export const nonStopOrdType = (ordType: OrdType): OrdType =>
  ordType === OrdType.Stop
    ? OrdType.Market
    : ordType === OrdType.StopLimit
      ? OrdType.Limit
      : ordType;

/**
 * TIFs the OMS accepts for an order type, strategy and trading phase: the
 * strategy definition's list, less GTC for MARKET, only DAY / GTC for stops,
 * and no IOC / FOK outside continuous trading.
 */
export const isTimeInForceAllowed = (
  ordType: OrdType,
  tif: TimeInForce,
  strategy?: AlgoStrategy,
  phase?: string,
) =>
  algoStrategyDefinition(strategy).timeInForce.includes(tif) &&
  !(ordType === OrdType.Market && tif === TimeInForce.GoodTillCancel) &&
  !(isStopOrdType(ordType) && !STOP_TIME_IN_FORCE_VALUES.includes(tif)) &&
  !(
    phase &&
    phase !== TradingPhase.Continuous &&
    (tif === TimeInForce.ImmediateOrCancel || tif === TimeInForce.FillOrKill)
  );

/** The TIFs to offer, in display order. */
export const allowedTimesInForce = (
  ordType: OrdType,
  strategy?: AlgoStrategy,
  phase?: string,
) =>
  ORDER_TICKET_TIFS.filter((tif) =>
    isTimeInForceAllowed(ordType, tif, strategy, phase),
  );

/**
 * Strategies whose name, id or description matches `query`, in picker
 * order (grouped).
 */
export const filterStrategies = (
  query = "",
): readonly AlgoStrategyDefinition[] => {
  const q = query.trim().toLowerCase();
  return ALGO_STRATEGY_GROUPS.flatMap((group) =>
    ALGO_STRATEGY_DEFINITIONS.filter(
      (d) =>
        d.group === group &&
        (!q ||
          d.name.toLowerCase().includes(q) ||
          d.id.toLowerCase().includes(q) ||
          d.description.toLowerCase().includes(q)),
    ),
  );
};

/** Minutes from `45`, `45m`, `1h`, `1.5h`, `1h30`. NaN if invalid, undefined if empty. */
export const parseDurationInput = (text: string | undefined) => {
  const t = (text ?? "").trim().toLowerCase();
  if (!t || t === "close") return undefined;
  let m = /^(\d+(?:\.\d+)?)\s*h$/.exec(t);
  if (m) return Math.round(Number(m[1]) * 60);
  m = /^(\d+)\s*h\s*(\d+)\s*m?$/.exec(t);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  m = /^(\d+(?:\.\d+)?)\s*(m|min|mins)?$/.exec(t);
  if (m) return Number(m[1]);
  return Number.NaN;
};

/** "HH:MM" from `15:30`, `1530`, `930`. Null if invalid, undefined if empty. */
export const parseTimeInput = (text: string | undefined) => {
  const t = (text ?? "").trim().toLowerCase();
  if (!t || t === "close") return undefined;
  const m = /^([01]?\d|2[0-3]):?([0-5]\d)$/.exec(t);
  if (!m) return null;
  return `${m[1].padStart(2, "0")}:${m[2]}`;
};

/** Percent from `10` or `10%`. NaN if invalid, undefined if empty. */
export const parsePercentInput = (text: string | undefined) => {
  const t = (text ?? "").trim().replace(/%$/, "").trim();
  if (!t) return undefined;
  const v = Number(t);
  return Number.isFinite(v) ? v : Number.NaN;
};

/** A parameter's createOrder value, or an error. */
export const parseAlgoParam = (
  param: AlgoParamDefinition,
  text: string | undefined,
): { value?: number | string; error?: string } => {
  const range = (v: number, unit: string) =>
    param.min !== undefined && param.max !== undefined
      ? !(v >= param.min && v <= param.max)
        ? `${param.label} must be ${param.min} to ${param.max}${unit}`
        : undefined
      : undefined;
  switch (param.type) {
    case "duration": {
      const v = parseDurationInput(text);
      if (v === undefined)
        return param.required
          ? { error: `Enter ${param.label.toLowerCase()}` }
          : {};
      if (Number.isNaN(v))
        return { error: `${param.label}: use minutes, 45m or 1h` };
      const error = range(v, " minutes");
      return error ? { error } : { value: v };
    }
    case "time": {
      const v = parseTimeInput(text);
      if (v === undefined)
        return param.required
          ? { error: `Enter ${param.label.toLowerCase()}` }
          : {};
      return v === null
        ? { error: `${param.label} must be HH:MM` }
        : { value: v };
    }
    case "percent": {
      const v = parsePercentInput(text);
      if (v === undefined)
        return param.required
          ? { error: `Enter ${param.label.toLowerCase()}` }
          : {};
      if (Number.isNaN(v)) return { error: `${param.label} must be a number` };
      const error = range(v, "%");
      return error ? { error } : { value: v };
    }
  }
};

/** Algo fields of the draft: errors, and createOrder params when valid. */
const validateAlgoFields = (draft: OrderDraft, errors: OrderDraftErrors) => {
  const strategy = draft.strategy ?? AlgoStrategy.Dma;
  const definition = algoStrategyDefinition(strategy);
  // Market + GTC and the phase rules are reported by validateOrder.
  if (!definition.timeInForce.includes(draft.timeInForce)) {
    errors.timeInForce = `${draft.timeInForce} is not valid for ${definition.name} orders`;
  }
  if (strategy === AlgoStrategy.Dma) return {};
  const params: Partial<CreateOrderRequest> = { strategy };
  for (const param of definition.params) {
    const { value, error } = parseAlgoParam(
      param,
      draft.algoParams?.[param.key],
    );
    if (error) errors[param.key] = error;
    else if (value !== undefined)
      (params as Record<string, unknown>)[param.key] = value;
  }
  return params;
};

/**
 * USD per unit of instrument price, by instrument currency. Mirrors the
 * exchange simulator's reference rates (GBX prices are pence). Indicative:
 * the OMS uses its own rates and is authoritative.
 */
export const INDICATIVE_USD_PER_PRICE_UNIT: Readonly<Record<string, number>> =
  Object.freeze({
    USD: 1,
    GBX: 0.0127,
    GBP: 1.27,
    EUR: 1.08,
    CHF: 1.12,
    HKD: 0.128,
  });

/** Default OMS limit price collar (oms.collarPct). */
export const DEFAULT_COLLAR_PCT = 0.1;

const SUFFIX: Record<string, number> = { k: 1_000, m: 1_000_000 };

const positive = (value: unknown): number | undefined =>
  typeof value === "number" && value > 0 ? value : undefined;

/** Parse quantity input: `1,000`, `10k`, `1.5m`. NaN if not a number. */
export const parseQuantity = (text: string): number => {
  const match = /^\s*([\d,]*\.?\d*)\s*([kKmM]?)\s*$/.exec(text);
  if (!match || match[1] === "" || match[1] === ".") return Number.NaN;
  const value = Number(match[1].replaceAll(",", ""));
  return match[2] ? Math.round(value * SUFFIX[match[2].toLowerCase()]) : value;
};

/** Parse price input (`1,234.5`). NaN if not a number, undefined if empty. */
export const parsePrice = (text: string): number | undefined => {
  if (text.trim() === "") return undefined;
  const value = Number(text.replaceAll(",", "").trim());
  return Number.isFinite(value) ? value : Number.NaN;
};

const PRICE_SHORTHAND = /^\s*(b|bid|a|ask|m|mid)\s*(?:([+-])\s*(\d+))?\s*$/i;

/** Whether price input is shorthand (`b`, `a`, `m`, `b+2`, `a-1`). */
export const isPriceShorthand = (text: string) => PRICE_SHORTHAND.test(text);

/**
 * Price input as a number: a plain price, or shorthand relative to the
 * touch: `b` bid, `a` ask, `m` mid (rounded to the tick), with `+n` / `-n`
 * ticks (band aware). NaN if invalid or the touch is unknown, undefined if
 * empty.
 */
export const resolvePriceInput = (
  text: string,
  instrument: OrderTicketInstrument | undefined,
): number | undefined => {
  const m = PRICE_SHORTHAND.exec(text);
  if (!m) return parsePrice(text);
  const bid = positive(instrument?.bid);
  const ask = positive(instrument?.ask);
  const schedule = scheduleOf(instrument);
  const kind = m[1][0].toLowerCase();
  let base: number | undefined;
  if (kind === "b") base = bid;
  else if (kind === "a") base = ask;
  else if (bid !== undefined && ask !== undefined) {
    base = (bid + ask) / 2;
    if (schedule) base = roundToTick(base, schedule);
  }
  if (base === undefined) return Number.NaN;
  const ticks = m[3] ? Number(m[3]) * (m[2] === "-" ? -1 : 1) : 0;
  if (ticks && schedule) base = stepTicks(base, schedule, ticks);
  return base > 0 ? base : Number.NaN;
};

/** What price shorthand refers to, for a hint ("Bid +2"), else undefined. */
export const describePriceShorthand = (text: string) => {
  const m = PRICE_SHORTHAND.exec(text);
  if (!m) return undefined;
  const name = { b: "Bid", a: "Ask", m: "Mid" }[m[1][0].toLowerCase()];
  return m[3] && m[3] !== "0" ? `${name} ${m[2]}${m[3]}` : name;
};

const VALUE_INPUT = /^\s*\$\s*([\d,]*\.?\d*)\s*([kKmM]?)\s*$/;

/** Whether quantity input is a USD value (`$250k`). */
export const isValueInput = (text: string) => VALUE_INPUT.test(text);

/**
 * Quantity input as shares (contracts for a future): `1,000`, `10k`, `1.5m`,
 * or a USD value (`$250k`) converted at `price` and the contract multiplier,
 * rounded to whole lots (at least one).
 * NaN if invalid or a value can't be converted.
 */
export const resolveQuantityInput = (
  text: string,
  instrument: OrderTicketInstrument | undefined,
  price: number | undefined,
  usdPerPriceUnit: Readonly<
    Record<string, number>
  > = INDICATIVE_USD_PER_PRICE_UNIT,
): number => {
  const m = VALUE_INPUT.exec(text);
  if (!m) return parseQuantity(text);
  if (m[1] === "" || m[1] === ".") return Number.NaN;
  const usd =
    Number(m[1].replaceAll(",", "")) * (m[2] ? SUFFIX[m[2].toLowerCase()] : 1);
  const rate = instrument?.currency
    ? usdPerPriceUnit[instrument.currency]
    : undefined;
  if (!rate || !price || !(price > 0)) return Number.NaN;
  const lot =
    instrument?.lotSize && instrument.lotSize > 0 ? instrument.lotSize : 1;
  const value = price * rate * contractMultiplierOf(instrument);
  return Math.max(lot, Math.round(usd / value / lot) * lot);
};

/**
 * Tick schedule of an order ticket instrument (tickBands over tickSize);
 * undefined without a tickSize.
 */
export const scheduleOf = (
  instrument: OrderTicketInstrument | undefined,
): TickSchedule | undefined =>
  instrument?.tickSize !== undefined
    ? tickScheduleOf({
        tickSize: instrument.tickSize,
        tickBands: instrument.tickBands || undefined,
      })
    : undefined;

/** Price as input text, with the instrument's decimals (no grouping). */
export const formatPriceInput = (
  price: number,
  instrument: OrderTicketInstrument | undefined,
) =>
  price.toFixed(
    priceDecimals(price, {
      priceDecimals: instrument?.priceDecimals,
      tickSize: instrument?.tickSize,
      tickBands: instrument?.tickBands || undefined,
    }),
  );

/** Reference for risk checks, as the OMS: last, else mid, else refPrice. */
export const referencePrice = (
  instrument: OrderTicketInstrument | undefined,
) => {
  if (!instrument) return undefined;
  const bid = positive(instrument.bid);
  const ask = positive(instrument.ask);
  return (
    positive(instrument.last) ??
    (bid !== undefined && ask !== undefined ? (bid + ask) / 2 : undefined) ??
    positive(instrument.refPrice)
  );
};

/** Passive price to start from: bid for a buy, ask for a sell. */
export const defaultLimitPrice = (
  side: Side,
  instrument: OrderTicketInstrument | undefined,
) =>
  (side === Side.Buy ? positive(instrument?.bid) : positive(instrument?.ask)) ??
  referencePrice(instrument);

/** Price a market order is valued at: the far touch, else the reference. */
export const marketValuationPrice = (
  side: Side,
  instrument: OrderTicketInstrument | undefined,
) =>
  (side === Side.Buy ? positive(instrument?.ask) : positive(instrument?.bid)) ??
  referencePrice(instrument);

/**
 * Move the draft price by `ticks` (band aware). An empty price starts from
 * the passive touch. Returns undefined if there is nothing to step from.
 */
export const nudgePrice = (
  draft: Pick<OrderDraft, "price" | "side">,
  instrument: OrderTicketInstrument | undefined,
  ticks: number,
): string | undefined => {
  const schedule = scheduleOf(instrument);
  if (schedule === undefined) return undefined;
  const current = parsePrice(draft.price);
  if (current === undefined || Number.isNaN(current) || current <= 0) {
    const start = defaultLimitPrice(draft.side, instrument);
    return start === undefined
      ? undefined
      : formatPriceInput(start, instrument);
  }
  const next = stepTicks(current, schedule, ticks);
  return next > 0 ? formatPriceInput(next, instrument) : undefined;
};

/**
 * Where an empty stop price starts: one tick beyond the market price (above
 * it for a buy, below for a sell), since a stop already reached is refused.
 */
export const defaultStopPrice = (
  side: Side,
  instrument: OrderTicketInstrument | undefined,
) => {
  const market = referencePrice(instrument);
  const schedule = scheduleOf(instrument);
  if (market === undefined || schedule === undefined) return undefined;
  const start = stepTicks(
    roundToTick(market, schedule),
    schedule,
    side === Side.Buy ? 1 : -1,
  );
  return start > 0 ? start : undefined;
};

/**
 * Move the draft stop price by `ticks` (band aware). An empty stop starts
 * one tick beyond the market price (see defaultStopPrice).
 */
export const nudgeStopPrice = (
  draft: Pick<OrderDraft, "stopPrice" | "side">,
  instrument: OrderTicketInstrument | undefined,
  ticks: number,
): string | undefined => {
  const schedule = scheduleOf(instrument);
  if (schedule === undefined) return undefined;
  const current = parsePrice(draft.stopPrice);
  if (current === undefined || Number.isNaN(current) || current <= 0) {
    const start = defaultStopPrice(draft.side, instrument);
    return start === undefined
      ? undefined
      : formatPriceInput(start, instrument);
  }
  const next = stepTicks(current, schedule, ticks);
  return next > 0 ? formatPriceInput(next, instrument) : undefined;
};

/** Step quantity by whole lots (never below one lot). */
export const nudgeQuantity = (
  quantityText: string,
  instrument: OrderTicketInstrument | undefined,
  lots: number,
): string => {
  const lot =
    instrument?.lotSize && instrument.lotSize > 0 ? instrument.lotSize : 1;
  const current = parseQuantity(quantityText);
  const base = Number.isFinite(current) ? Math.round(current / lot) * lot : 0;
  return String(Math.max(lot, base + lots * lot));
};

const FIELD_FOR_REASON: Partial<Record<string, OrderDraftField>> = {
  [RejectReason.InvalidQuantity]: "quantity",
  [RejectReason.InvalidLotSize]: "quantity",
  [RejectReason.ExceedsMaxQuantity]: "quantity",
  [RejectReason.MissingPrice]: "price",
  [RejectReason.InvalidPrice]: "price",
  [RejectReason.InvalidTickSize]: "price",
  [RejectReason.PriceOutsideCollar]: "price",
  [RejectReason.MissingStopPrice]: "stopPrice",
  [RejectReason.InvalidStopPrice]: "stopPrice",
  [RejectReason.UnsupportedTimeInForce]: "timeInForce",
  [RejectReason.UnsupportedOrdType]: "ordType",
  [RejectReason.UnknownInstrument]: "ric",
  [RejectReason.UnknownAccount]: "account",
  [RejectReason.AccountDisabled]: "account",
};

/** Draft field a server / validation reject reason relates to, if any. */
export const fieldForRejectReason = (
  reason: string,
): OrderDraftField | "form" => FIELD_FOR_REASON[reason] ?? "form";

/**
 * Price the order is valued at (and `$` quantities converted at): the limit
 * for LIMIT / STOP_LIMIT, the stop for STOP (it trades near there once
 * triggered), else the far touch for MARKET.
 */
const valuationPrice = (
  draft: OrderDraft,
  instrument: OrderTicketInstrument | undefined,
  limit: number | undefined,
  stopPrice: number | undefined,
) => {
  if (isPricedOrdType(draft.ordType)) return limit;
  if (draft.ordType === OrdType.Stop)
    return stopPrice !== undefined && stopPrice > 0 ? stopPrice : undefined;
  return marketValuationPrice(draft.side, instrument);
};

export interface DraftValidation {
  errors: OrderDraftErrors;
  /** createOrder params (without clOrdId) when the draft is valid. */
  params?: Omit<CreateOrderRequest, "clOrdId">;
}

/**
 * Client-side validation with the shared trading-schemas rules
 * (validateOrder + validateRpcParams). The OMS re-validates and also applies
 * risk checks; it is authoritative.
 */
export const validateDraft = (
  draft: OrderDraft,
  instrument: OrderTicketInstrument | undefined,
  accounts?: readonly OrderTicketAccount[],
): DraftValidation => {
  const errors: OrderDraftErrors = {};
  if (!draft.ric) errors.ric = "Select an instrument";
  else if (
    instrument?.ric === draft.ric &&
    instrument.instrumentType === InstrumentType.Index
  )
    errors.ric = `${draft.ric} is an index: trade its futures`;
  if (!draft.account) {
    errors.account = "Select an account";
  } else if (accounts) {
    const account = accounts.find((a) => a.account === draft.account);
    if (!account) errors.account = `Account ${draft.account} is not available`;
    else if (account.enabled === false)
      errors.account = `Account ${draft.account} is disabled`;
  }

  const priced = isPricedOrdType(draft.ordType);
  const stop = isStopOrdType(draft.ordType);
  const price = priced ? resolvePriceInput(draft.price, instrument) : undefined;
  const stopPrice = stop
    ? resolvePriceInput(draft.stopPrice, instrument)
    : undefined;
  const quantity = resolveQuantityInput(
    draft.quantity,
    instrument,
    valuationPrice(draft, instrument, price, stopPrice),
  );
  if (draft.quantity.trim() === "") errors.quantity = "Enter a quantity";
  else if (Number.isNaN(quantity))
    errors.quantity = isValueInput(draft.quantity)
      ? "Can't convert a value without a price"
      : "Quantity must be a number, 10k or $250k";
  if (priced && price === undefined) errors.price = "Enter a limit price";
  else if (priced && Number.isNaN(price))
    errors.price = isPriceShorthand(draft.price)
      ? "No bid / ask to price from"
      : "Price must be a number, or b / a / m";
  if (stop && stopPrice === undefined) errors.stopPrice = "Enter a stop price";
  else if (stop && Number.isNaN(stopPrice))
    errors.stopPrice = isPriceShorthand(draft.stopPrice)
      ? "No bid / ask to price from"
      : "Stop price must be a number, or b / a / m";
  if (!isStrategyAllowed(draft.ordType, draft.strategy)) {
    errors.strategy = "Stop orders are DMA only";
  }

  if (draft.ric && instrument?.ric === draft.ric) {
    if (
      instrument.tickSize !== undefined &&
      instrument.lotSize !== undefined &&
      !errors.quantity &&
      !errors.price &&
      !errors.stopPrice
    ) {
      const reject =
        validateOrder(
          {
            side: draft.side,
            ordType: draft.ordType,
            quantity,
            price,
            stopPrice,
            timeInForce: draft.timeInForce,
          },
          {
            ric: instrument.ric,
            currency: instrument.currency ?? "",
            exchange: instrument.exchange ?? "",
            tickSize: instrument.tickSize,
            tickBands: instrument.tickBands || undefined,
            lotSize: instrument.lotSize,
          },
          (instrument.phase as TradingPhase | undefined) ||
            TradingPhase.Continuous,
        ) ??
        // A stop already reached would trigger at once: say so before Send.
        (stopPrice !== undefined
          ? validateStopTrigger(
              draft.side,
              stopPrice,
              referencePrice(instrument),
            )
          : undefined);
      if (reject) {
        const field = fieldForRejectReason(reject.reason);
        errors[field] ??= reject.text;
      }
    } else if (instrument.tickSize === undefined) {
      errors.ric ??= "Loading instrument…";
    }
  } else if (draft.ric) {
    errors.ric ??= "Loading instrument…";
  }

  const algoParams = validateAlgoFields(draft, errors);
  if (Object.keys(errors).length > 0) return { errors };

  const parsed = validateRpcParams("createOrder", {
    ...algoParams,
    account: draft.account,
    ric: draft.ric,
    side: draft.side,
    ordType: draft.ordType,
    quantity,
    ...(price !== undefined ? { price } : {}),
    ...(stopPrice !== undefined ? { stopPrice } : {}),
    timeInForce: draft.timeInForce,
  });
  if (!parsed.ok) return { errors: { form: parsed.errors.join("; ") } };
  return { errors, params: parsed.value };
};

export interface RiskWarning {
  code: "maxOrderQty" | "maxOrderNotional" | "collar" | "noPrice";
  text: string;
}

export interface RiskPreview {
  /** Valuation price (limit, stop for STOP, or far touch for market). */
  price?: number;
  /** Quantity in shares (shorthand and $ values resolved). */
  quantity?: number;
  /** quantity × price, in instrument currency (GBX: pence). */
  notional?: number;
  currency?: string;
  /** Indicative USD equivalent, if a rate is known. */
  notionalUsd?: number;
  /** Reference price for the collar (last, else mid, else refPrice). */
  referencePrice?: number;
  /** Limit price distance from the reference, as a fraction. */
  collarDistance?: number;
  warnings: RiskWarning[];
}

export interface RiskPreviewOptions {
  /** USD per unit of instrument price by currency; `{}` disables USD. */
  usdPerPriceUnit?: Readonly<Record<string, number>>;
  collarPct?: number;
}

const grouped = (value: number) => value.toLocaleString("en-GB");

/**
 * Notional and pre-trade risk preview, mirroring the OMS checks client side
 * (account limits are USD; the limit collar is ±collarPct of the reference).
 * Advisory only: warnings never block submission.
 */
export const previewRisk = (
  draft: OrderDraft,
  instrument: OrderTicketInstrument | undefined,
  account: OrderTicketAccount | undefined,
  {
    usdPerPriceUnit = INDICATIVE_USD_PER_PRICE_UNIT,
    collarPct = DEFAULT_COLLAR_PCT,
  }: RiskPreviewOptions = {},
): RiskPreview => {
  const warnings: RiskWarning[] = [];
  const priced = isPricedOrdType(draft.ordType);
  const limit = priced ? resolvePriceInput(draft.price, instrument) : undefined;
  const stop =
    draft.ordType === OrdType.Stop
      ? resolvePriceInput(draft.stopPrice, instrument)
      : undefined;
  const validLimit =
    limit !== undefined && !Number.isNaN(limit) && limit > 0
      ? limit
      : undefined;
  const price = valuationPrice(
    draft,
    instrument,
    validLimit,
    stop !== undefined && !Number.isNaN(stop) ? stop : undefined,
  );
  const quantity = resolveQuantityInput(
    draft.quantity,
    instrument,
    price,
    usdPerPriceUnit,
  );
  const currency = instrument?.currency;
  const reference = referencePrice(instrument);
  const preview: RiskPreview = {
    price,
    quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : undefined,
    currency,
    referencePrice: reference,
    warnings,
  };

  if (Number.isFinite(quantity) && quantity > 0) {
    if (account?.maxOrderQty && quantity > account.maxOrderQty) {
      warnings.push({
        code: "maxOrderQty",
        text: `Quantity exceeds the account limit of ${grouped(account.maxOrderQty)}`,
      });
    }
    if (price !== undefined) {
      preview.notional = quantity * price * contractMultiplierOf(instrument);
      const rate = currency ? usdPerPriceUnit[currency] : undefined;
      if (rate !== undefined) {
        preview.notionalUsd = preview.notional * rate;
        if (
          account?.maxOrderNotional &&
          preview.notionalUsd > account.maxOrderNotional
        ) {
          warnings.push({
            code: "maxOrderNotional",
            text: `Notional exceeds the account limit of ${grouped(account.maxOrderNotional)} USD`,
          });
        }
      }
    } else if (draft.ordType === OrdType.Market && instrument) {
      warnings.push({
        code: "noPrice",
        text: "No market price to value the order",
      });
    }
  }
  if (validLimit !== undefined && reference !== undefined) {
    preview.collarDistance = Math.abs(validLimit - reference) / reference;
    if (preview.collarDistance > collarPct) {
      warnings.push({
        code: "collar",
        text: `Price is ${(preview.collarDistance * 100).toFixed(1)}% from the reference price (collar ±${(collarPct * 100).toFixed(0)}%)`,
      });
    }
  }
  return preview;
};

let clOrdIdSeq = 0;
/** A client order id, unique per session (well under the 64 char limit). */
export const newClOrdId = (prefix = "TKT") =>
  `${prefix}-${Date.now().toString(36)}-${(++clOrdIdSeq).toString(36)}${Math.random()
    .toString(36)
    .slice(2, 6)}`.toUpperCase();

export const EMPTY_DRAFT: OrderDraft = Object.freeze({
  side: Side.Buy,
  ordType: OrdType.Limit,
  timeInForce: TimeInForce.Day,
  quantity: "",
  price: "",
  stopPrice: "",
  strategy: AlgoStrategy.Dma,
  algoParams: Object.freeze({}),
});

/** Warnings that make Send a two-step Review (limits and the collar). */
const REVIEW_WARNINGS: ReadonlySet<RiskWarning["code"]> = new Set([
  "maxOrderQty",
  "maxOrderNotional",
  "collar",
]);

/** The warnings that need the order reviewed before it is sent. */
export const reviewReasons = (risk: RiskPreview) =>
  risk.warnings.filter((w) => REVIEW_WARNINGS.has(w.code));

const grouped0 = (n: number) =>
  n.toLocaleString("en-GB", { maximumFractionDigits: 0 });

/**
 * One line on how the strategy will work the order, for the ticket. Built
 * from the definition's parameters; null for DMA.
 */
export const scheduleSummary = (
  draft: OrderDraft,
  quantity: number | undefined,
): string | null => {
  const definition = algoStrategyDefinition(draft.strategy);
  if (definition.id === AlgoStrategy.Dma) return null;
  const values: Partial<Record<AlgoParamKey, number | string>> = {};
  for (const param of definition.params) {
    const { value } = parseAlgoParam(param, draft.algoParams?.[param.key]);
    if (value !== undefined) values[param.key] = value;
  }
  const mins = values.durationMins as number | undefined;
  switch (definition.id) {
    case AlgoStrategy.Twap: {
      const over = mins ?? 30;
      return quantity
        ? `≈ ${grouped0(Math.ceil(quantity / over))} a minute for ${over} min`
        : `Even slices for ${over} min`;
    }
    case AlgoStrategy.Vwap:
      return `Follows the volume curve until ${values.endTime ?? "the close"}`;
    case AlgoStrategy.Pov:
      return values.participationPct !== undefined
        ? `${values.participationPct}% of market volume until ${mins ? `${mins} min` : "the close"}`
        : "Set a participation rate";
    default:
      return definition.description;
  }
};

/** What an order line set, and how each word was read (for chips). */
export interface OrderLine {
  change: Partial<OrderDraft>;
  /** One entry per word: a label, or `unknown` for words not understood. */
  words: { text: string; label?: string }[];
}

const QTY_WORD = /^(\$[\d,.]+[km]?|[\d,]*\.?\d+[km]?)$/i;
const PRICE_WORD = /^((b|bid|a|ask|m|mid)([+-]\d+)?|[\d,]*\.?\d+)$/i;

/**
 * Parse an order typed as one line, e.g. `b 20k aal.l m vwap 15:30`:
 * side (first word, `b` / `s`), quantity (first number), instrument (a word
 * with a dot), price (a later number or `b` / `a` / `m`, `mkt` for market),
 * strategy (by id or name) and its parameters (by their form: `45m`,
 * `15:30`, `10%`). Words may come in any order after the side, except that
 * quantity comes before price. Missing parts are left as they are.
 *
 * Stops: `stop` (or `stp`) takes the next price as the stop price; with a
 * limit price as well the order is a STOP_LIMIT, e.g. `s 200 vod.l stop
 * 99.5` (STOP) and `s 200 vod.l stop 99.5 lmt 99.4` (STOP_LIMIT). `lmt`
 * (`limit`) before a price is optional: any other price is the limit.
 */
export const parseOrderLine = (text: string): OrderLine => {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  const change: Partial<OrderDraft> = {};
  const algoParams: Partial<Record<AlgoParamKey, string>> = {};
  const words: OrderLine["words"] = [];
  let definition: AlgoStrategyDefinition | undefined;
  let stop = false;
  /** The previous word was `stop` / `lmt`: the next price is for it. */
  let expect: "stop" | "limit" | undefined;
  for (const [i, token] of tokens.entries()) {
    const t = token.toLowerCase();
    const word = (label?: string) => words.push({ text: token, label });
    const pending = expect;
    expect = undefined;
    if (i === 0 && /^(b|buy|s|sell)$/.test(t)) {
      change.side = t[0] === "b" ? Side.Buy : Side.Sell;
      word(change.side === Side.Buy ? "Buy" : "Sell");
      continue;
    }
    if (pending === "stop" && PRICE_WORD.test(t)) {
      change.stopPrice = token;
      word(`Stop ${token}`);
      continue;
    }
    if (
      pending === "limit" &&
      change.ordType !== OrdType.Market &&
      PRICE_WORD.test(t)
    ) {
      change.price = token;
      word(`Limit ${token}`);
      continue;
    }
    if (/^(stop|stp)$/.test(t)) {
      stop = true;
      expect = "stop";
      word("Stop");
      continue;
    }
    if (/^(lmt|limit|lim)$/.test(t)) {
      expect = "limit";
      word("Limit");
      continue;
    }
    const strategy = ALGO_STRATEGY_DEFINITIONS.find(
      (d) => d.id.toLowerCase() === t || d.name.toLowerCase() === t,
    );
    if (strategy) {
      definition = strategy;
      change.strategy = strategy.id;
      word(strategy.name);
      continue;
    }
    if (/^(mkt|market)$/.test(t)) {
      change.ordType = OrdType.Market;
      word("Market");
      continue;
    }
    if (definition) {
      // A word with a unit goes to the parameter of that type (`10%`,
      // `45m`, `15:30`). After the strategy, a bare number is the next
      // unfilled parameter if valid there (`pov 10` = 10%, `twap 45` = 45
      // min); prices go before the strategy.
      const unfilled = definition.params.filter(
        (p) => algoParams[p.key] === undefined,
      );
      const bare = /^\d+(\.\d+)?$/.test(t);
      const param = bare
        ? unfilled[0] && !parseAlgoParam(unfilled[0], token).error
          ? unfilled[0]
          : undefined
        : unfilled.find((p) =>
            p.type === "percent"
              ? /%$/.test(t)
              : p.type === "time"
                ? /^\d{1,2}:\d\d$/.test(t)
                : /^\d+(\.\d+)?(m|h|min)$|^\d+h\d+m?$/.test(t),
          );
      if (param) {
        algoParams[param.key] = token;
        word(`${param.label} ${token}`);
        continue;
      }
    }
    if (change.quantity === undefined && QTY_WORD.test(t)) {
      change.quantity = token;
      word(`Qty ${token}`);
      continue;
    }
    if (
      change.price === undefined &&
      change.ordType !== OrdType.Market &&
      PRICE_WORD.test(t)
    ) {
      change.price = token;
      change.ordType = OrdType.Limit;
      word(stop ? `Limit ${token}` : `@ ${token}`);
      continue;
    }
    if (change.ric === undefined && /^[a-z0-9]+\.[a-z0-9]+$/i.test(t)) {
      change.ric = token.toUpperCase();
      word(change.ric);
      continue;
    }
    word(undefined);
  }
  if (stop) {
    change.ordType =
      change.price !== undefined ? OrdType.StopLimit : OrdType.Stop;
  } else if (change.price !== undefined && change.ordType !== OrdType.Market) {
    change.ordType = OrdType.Limit;
  }
  if (change.strategy) change.algoParams = algoParams;
  return { change, words };
};

/** Whether text in the instrument field is an order line, not a search. */
export const isOrderLine = (text: string) => /\s/.test(text.trim());
