import {
  decimalsOf,
  parseTickBands,
  type TickSchedule,
  tickSizeAt,
} from "@heswell/trading-schemas";

const formatters = new Map<string, Intl.NumberFormat>();
const numberFormat = (options: Intl.NumberFormatOptions) => {
  const key = JSON.stringify(options);
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat("en-GB", options);
    formatters.set(key, formatter);
  }
  return formatter;
};

const EMPTY = "";
const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

export interface PriceFormat {
  /** Fixed decimals (instruments.priceDecimals) - takes precedence. */
  priceDecimals?: number;
  /** Tick size or schedule; decimals follow the tick at the price. */
  tickSize?: TickSchedule;
  /** instruments.tickBands (`from:tick;...`) - overrides tickSize. */
  tickBands?: string;
}

/** Decimal places used to display `price` for an instrument. */
export const priceDecimals = (
  price: number,
  { priceDecimals, tickBands, tickSize }: PriceFormat = {},
) => {
  if (priceDecimals !== undefined) return priceDecimals;
  const schedule = parseTickBands(tickBands) ?? tickSize;
  return schedule === undefined ? 2 : decimalsOf(tickSizeAt(schedule, price));
};

/**
 * Format a price to the instrument's precision, e.g. 436.5 with tick 0.1
 * -> "436.5"; 1234.5 with priceDecimals 2 -> "1,234.50".
 */
export const formatPrice = (price: unknown, format: PriceFormat = {}) => {
  if (!isNumber(price)) return EMPTY;
  const decimals = priceDecimals(price, format);
  return numberFormat({
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(price);
};

/** Whole-unit quantity with grouping; `compact` -> 1.2K, 3.4M. */
export const formatQuantity = (
  quantity: unknown,
  { compact = false }: { compact?: boolean } = {},
) => {
  if (!isNumber(quantity)) return EMPTY;
  return numberFormat(
    compact
      ? { notation: "compact", maximumFractionDigits: 1 }
      : { maximumFractionDigits: 0 },
  ).format(quantity);
};

/**
 * Notional / P&L amount (2dp, grouped). `currency` appends the ISO code
 * (GBX amounts are pence, as published by the exchange).
 */
export const formatNotional = (
  amount: unknown,
  {
    compact = false,
    currency,
    signed = false,
  }: { compact?: boolean; currency?: string; signed?: boolean } = {},
) => {
  if (!isNumber(amount)) return EMPTY;
  const text = numberFormat({
    ...(compact
      ? { notation: "compact", maximumFractionDigits: 1 }
      : { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    signDisplay: signed ? "exceptZero" : "auto",
  }).format(amount);
  return currency ? `${text} ${currency}` : text;
};

/** Percentage value (already x100, e.g. changePct), signed: "+1.25%". */
export const formatPercent = (value: unknown, decimals = 2) => {
  if (!isNumber(value)) return EMPTY;
  return `${numberFormat({
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    signDisplay: "exceptZero",
  }).format(value)}%`;
};
