import {
  type CreateOrderRequest,
  isPricedOrdType,
  OrdType,
  RejectReason,
  SUPPORTED_ORD_TYPES,
  Side,
  stepTicks,
  type TickSchedule,
  TimeInForce,
  TradingPhase,
  tickScheduleOf,
  validateOrder,
  validateRpcParams,
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
  refPrice?: number;
  bid?: number;
  ask?: number;
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

/** The editable state of the ticket. Quantity and price are input text. */
export interface OrderDraft {
  ric?: string;
  side: Side;
  ordType: OrdType;
  timeInForce: TimeInForce;
  quantity: string;
  price: string;
  account?: string;
}

export type OrderDraftField =
  | "ric"
  | "side"
  | "ordType"
  | "timeInForce"
  | "quantity"
  | "price"
  | "account";

export type OrderDraftErrors = Partial<
  Record<OrderDraftField | "form", string>
>;

/** Order types the OMS accepts (STOP / STOP_LIMIT are reserved). */
export const ORDER_TICKET_ORD_TYPES = SUPPORTED_ORD_TYPES;
export const ORDER_TICKET_TIFS: readonly TimeInForce[] = [
  TimeInForce.Day,
  TimeInForce.ImmediateOrCancel,
  TimeInForce.FillOrKill,
  TimeInForce.GoodTillCancel,
];

/** TIFs the OMS accepts for an order type (GTC is not valid for MARKET). */
export const isTimeInForceAllowed = (ordType: OrdType, tif: TimeInForce) =>
  !(ordType === OrdType.Market && tif === TimeInForce.GoodTillCancel);

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

const positive = (value: unknown): number | undefined =>
  typeof value === "number" && value > 0 ? value : undefined;

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
  if (!draft.account) {
    errors.account = "Select an account";
  } else if (accounts) {
    const account = accounts.find((a) => a.account === draft.account);
    if (!account) errors.account = `Account ${draft.account} is not available`;
    else if (account.enabled === false)
      errors.account = `Account ${draft.account} is disabled`;
  }

  const quantity = parseQuantity(draft.quantity);
  const priced = isPricedOrdType(draft.ordType);
  const price = priced ? parsePrice(draft.price) : undefined;
  if (draft.quantity.trim() === "") errors.quantity = "Enter a quantity";
  else if (Number.isNaN(quantity))
    errors.quantity = "Quantity must be a number";
  if (priced && price === undefined) errors.price = "Enter a limit price";
  else if (priced && Number.isNaN(price))
    errors.price = "Price must be a number";

  if (draft.ric && instrument?.ric === draft.ric) {
    if (
      instrument.tickSize !== undefined &&
      instrument.lotSize !== undefined &&
      !errors.quantity &&
      !errors.price
    ) {
      const reject = validateOrder(
        {
          side: draft.side,
          ordType: draft.ordType,
          quantity,
          price,
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
      );
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

  if (Object.keys(errors).length > 0) return { errors };

  const parsed = validateRpcParams("createOrder", {
    account: draft.account,
    ric: draft.ric,
    side: draft.side,
    ordType: draft.ordType,
    quantity,
    ...(price !== undefined ? { price } : {}),
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
  /** Valuation price (limit, or far touch for market). */
  price?: number;
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
  const quantity = parseQuantity(draft.quantity);
  const priced = isPricedOrdType(draft.ordType);
  const limit = priced ? parsePrice(draft.price) : undefined;
  const validLimit =
    limit !== undefined && !Number.isNaN(limit) && limit > 0
      ? limit
      : undefined;
  const price = priced
    ? validLimit
    : marketValuationPrice(draft.side, instrument);
  const currency = instrument?.currency;
  const reference = referencePrice(instrument);
  const preview: RiskPreview = {
    price,
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
      preview.notional = quantity * price;
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
    } else if (!priced && instrument) {
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
});
