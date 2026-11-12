import {
  InstrumentType,
  roundToTick,
  tickScheduleOf,
  tickSizeAt,
} from "@heswell/trading-schemas";
import type { InstrumentDef } from "./instruments";

const DAY_MS = 86_400_000;
const YEAR_MS = 365 * DAY_MS;

/** Futures month codes, January..December. */
const MONTH_CODES = "FGHJKMNQUVXZ";
const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
/** Quarterly expiry months (0-based): Mar, Jun, Sep, Dec. */
const QUARTERLY = [2, 5, 8, 11];

/** Contract multiplier by underlying currency (shares per contract). */
const MULTIPLIER: Record<string, number> = {
  USD: 100,
  GBX: 1000,
  EUR: 100,
  CHF: 100,
  HKD: 1000,
};
const DEFAULT_MULTIPLIER = 100;

export interface FuturesOptions {
  /** Contracts listed per underlying (front, next, ...). */
  contracts: number;
  /** Annual carry rate (financing less dividends), e.g. 0.03. */
  carryRate: number;
  /** Last-trading time of day, "HH:MM" UTC. */
  expiryTime: string;
}

export const DEFAULT_FUTURES_OPTIONS: Readonly<FuturesOptions> = Object.freeze({
  contracts: 2,
  carryRate: 0.03,
  expiryTime: "16:30",
});

/** Third Friday of `month` (0-based) in `year`, at `minuteOfDay` UTC. */
export const thirdFriday = (year: number, month: number, minuteOfDay = 0) => {
  const first = new Date(Date.UTC(year, month, 1)).getUTCDay();
  const day = 1 + ((5 - first + 7) % 7) + 14;
  return Date.UTC(year, month, day) + minuteOfDay * 60_000;
};

const minuteOfDay = (time: string) => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!match) throw Error(`futures: bad expiry time '${time}' (HH:MM)`);
  return Number(match[1]) * 60 + Number(match[2]);
};

/** The next `count` quarterly expiries strictly after `now`. */
export const quarterlyExpiries = (
  now: number,
  count: number,
  expiryTime = DEFAULT_FUTURES_OPTIONS.expiryTime,
): number[] => {
  const minutes = minuteOfDay(expiryTime);
  const expiries: number[] = [];
  const start = new Date(now);
  let year = start.getUTCFullYear();
  let q = QUARTERLY.findIndex((m) => m >= start.getUTCMonth());
  if (q < 0) {
    q = 0;
    year++;
  }
  while (expiries.length < count) {
    const expiry = thirdFriday(year, QUARTERLY[q], minutes);
    if (expiry > now) expiries.push(expiry);
    q++;
    if (q === QUARTERLY.length) {
      q = 0;
      year++;
    }
  }
  return expiries;
};

/** Root of a ric: the part before the venue suffix (AZN.L -> AZN). */
const rootOf = (ric: string) => ric.split(".")[0];

/** Futures ric: root + month code + last digit of the year, e.g. AZNZ6. */
export const futureRic = (underlying: string, expiry: number) => {
  const date = new Date(expiry);
  return `${rootOf(underlying)}${MONTH_CODES[date.getUTCMonth()]}${date.getUTCFullYear() % 10}`;
};

/** Years from `now` to `expiry` (0 once expired). */
export const yearsToExpiry = (expiry: number, now: number) =>
  Math.max(0, expiry - now) / YEAR_MS;

/** Theoretical futures price: spot carried to expiry. */
export const carriedPrice = (
  spot: number,
  carryRate: number,
  expiry: number,
  now: number,
) => spot * Math.exp(carryRate * yearsToExpiry(expiry, now));

/**
 * One futures contract on `underlying` expiring at `expiry`. Same venue,
 * currency and sector as the underlying; a fixed tick (the underlying's tick
 * at its reference price), lot size 1 and a multiplier by currency.
 */
export const toFutureDef = (
  underlying: InstrumentDef,
  expiry: number,
  now: number,
  carryRate = DEFAULT_FUTURES_OPTIONS.carryRate,
): InstrumentDef => {
  const tickSize = tickSizeAt(tickScheduleOf(underlying), underlying.refPrice);
  const date = new Date(expiry);
  return {
    ric: futureRic(underlying.ric, expiry),
    description: `${underlying.description} ${MONTH_NAMES[date.getUTCMonth()]} ${date.getUTCFullYear()} future`,
    currency: underlying.currency,
    exchange: underlying.exchange,
    sector: underlying.sector,
    instrumentType: InstrumentType.Future,
    underlying: underlying.ric,
    expiry,
    contractMultiplier: MULTIPLIER[underlying.currency] ?? DEFAULT_MULTIPLIER,
    tickSize,
    tickBands: "",
    lotSize: 1,
    priceDecimals: underlying.priceDecimals,
    refPrice: roundToTick(
      carriedPrice(underlying.refPrice, carryRate, expiry, now),
      tickSize,
    ),
    usdPerPriceUnit: underlying.usdPerPriceUnit,
  };
};

/**
 * List futures for each underlying ric: the next `contracts` quarterly
 * expiries after `now`. Throws on an unknown or non-equity underlying.
 */
export const listFutures = (
  universe: readonly InstrumentDef[],
  underlyings: readonly string[],
  now: number,
  options: Partial<FuturesOptions> = {},
): InstrumentDef[] => {
  const { contracts, carryRate, expiryTime } = {
    ...DEFAULT_FUTURES_OPTIONS,
    ...options,
  };
  if (underlyings.length === 0 || contracts <= 0) return [];
  const byRic = new Map(universe.map((i) => [i.ric, i]));
  const expiries = quarterlyExpiries(now, contracts, expiryTime);
  const futures = underlyings.flatMap((ric) => {
    const underlying = byRic.get(ric);
    if (!underlying)
      throw Error(`exchangeSim.futures: unknown underlying ${ric}`);
    if (
      (underlying.instrumentType ?? InstrumentType.Equity) !==
      InstrumentType.Equity
    )
      throw Error(`exchangeSim.futures: ${ric} is not an equity`);
    return expiries.map((expiry) =>
      toFutureDef(underlying, expiry, now, carryRate),
    );
  });
  for (const future of futures) {
    const clash = byRic.get(future.ric);
    if (clash)
      throw Error(
        `exchangeSim.futures: ${future.ric} (${future.underlying}) clashes with ${clash.underlying ?? clash.ric}`,
      );
    byRic.set(future.ric, future);
  }
  return futures;
};

/** Whether an instrument is a future. */
export const isFuture = (instrument: InstrumentDef) =>
  instrument.instrumentType === InstrumentType.Future;

/**
 * Add futures to an active set: every future, preceded by its underlying
 * when the underlying is not already active (underlyings first, so their
 * books exist before the futures that follow them).
 */
export const withFutures = (
  active: readonly InstrumentDef[],
  futures: readonly InstrumentDef[],
  universe: readonly InstrumentDef[],
): InstrumentDef[] => {
  const byRic = new Map(universe.map((i) => [i.ric, i]));
  const result = active.filter((i) => !isFuture(i));
  const have = new Set(result.map((i) => i.ric));
  for (const future of futures) {
    const ric = future.underlying ?? "";
    if (!have.has(ric)) {
      const underlying = byRic.get(ric);
      if (!underlying)
        throw Error(`exchangeSim: unknown underlying ${ric} of ${future.ric}`);
      result.push(underlying);
      have.add(ric);
    }
  }
  for (const future of futures) {
    if (!have.has(future.ric)) {
      result.push(future);
      have.add(future.ric);
    }
  }
  return result;
};
