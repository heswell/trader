import {
  black76Price,
  decimalsOf,
  InstrumentType,
  PutCall,
  roundToTick,
} from "@heswell/trading-schemas";
import {
  carriedPrice,
  contractMultiplierFor,
  MONTH_NAMES,
  minuteOfDay,
  rootOf,
  thirdFriday,
  yearsToExpiry,
} from "./futures";
import type { InstrumentDef } from "./instruments";

/** Option month letters: calls January..December, then puts. */
const CALL_MONTHS = "ABCDEFGHIJKL";
const PUT_MONTHS = "MNOPQRSTUVWX";

/** Option tick by currency (premium units); index options 0.05 points. */
const OPTION_TICK: Record<string, number> = { GBX: 0.5 };
const DEFAULT_OPTION_TICK = 0.01;
const INDEX_OPTION_TICK = 0.05;

/** Strike spacing as a share of spot, rounded to a 1 / 2 / 2.5 / 5 step. */
const STRIKE_STEP_SHARE = 0.025;

export interface OptionsOptions {
  /** Monthly expiries listed per underlying. */
  expiries: number;
  /** Strikes listed each side of the at-the-money strike. */
  strikes: number;
  /** Strikes each side of at-the-money that get a book (liquid). */
  bookStrikes: number;
  /** Nearest expiries whose liquid strikes get a book. */
  bookExpiries: number;
  /** Annual carry of the forward over spot. */
  carryRate: number;
  /** Last-trading time of day, "HH:MM" UTC. */
  expiryTime: string;
  /** Volatility for the listing reference prices. */
  vol: number;
}

export const DEFAULT_OPTIONS_OPTIONS: Readonly<OptionsOptions> = Object.freeze({
  expiries: 2,
  strikes: 10,
  bookStrikes: 2,
  bookExpiries: 1,
  carryRate: 0.03,
  expiryTime: "16:30",
  vol: 0.3,
});

const isIndexDef = (instrument: InstrumentDef) =>
  instrument.instrumentType === InstrumentType.Index;

/** The next `count` monthly expiries (third Friday) strictly after `now`. */
export const monthlyExpiries = (
  now: number,
  count: number,
  expiryTime = DEFAULT_OPTIONS_OPTIONS.expiryTime,
): number[] => {
  const minutes = minuteOfDay(expiryTime);
  const start = new Date(now);
  let year = start.getUTCFullYear();
  let month = start.getUTCMonth();
  const expiries: number[] = [];
  while (expiries.length < count) {
    const expiry = thirdFriday(year, month, minutes);
    if (expiry > now) expiries.push(expiry);
    if (++month === 12) {
      month = 0;
      year++;
    }
  }
  return expiries;
};

/** A "nice" strike step near 2.5% of spot: 1, 2, 2.5 or 5 times a power of ten. */
export const strikeStep = (spot: number) => {
  const raw = spot * STRIKE_STEP_SHARE;
  const power = 10 ** Math.floor(Math.log10(raw));
  const nice = [1, 2, 2.5, 5, 10].find((m) => m * power >= raw) ?? 10;
  return nice * power;
};

/** Strikes centred on the at-the-money strike: `count` each side, all > 0. */
export const strikeGrid = (spot: number, count: number) => {
  const step = strikeStep(spot);
  const atm = Math.round(spot / step) * step;
  const strikes: number[] = [];
  for (let i = -count; i <= count; i++) {
    const strike = Number((atm + i * step).toFixed(decimalsOf(step)));
    if (strike > 0) strikes.push(strike);
  }
  return strikes;
};

/**
 * Option ric: root + strike + month letter + year digit. Calls use A-L for
 * January..December and puts M-X (the OPRA convention), so AAPL200L6 is the
 * Dec 2026 200 call and AAPL200X6 the put. A decimal point in the strike is
 * written D (VOD102D5L6): rics stay free of the "." venue separator.
 */
export const optionRic = (
  underlying: string,
  putCall: PutCall,
  strike: number,
  expiry: number,
) => {
  const date = new Date(expiry);
  const letters = putCall === PutCall.Call ? CALL_MONTHS : PUT_MONTHS;
  return `${rootOf(underlying)}${String(strike).replace(".", "D")}${letters[date.getUTCMonth()]}${date.getUTCFullYear() % 10}`;
};

/** Premium tick of an option on `underlying`. */
export const optionTick = (underlying: InstrumentDef) =>
  isIndexDef(underlying)
    ? INDEX_OPTION_TICK
    : (OPTION_TICK[underlying.currency] ?? DEFAULT_OPTION_TICK);

/**
 * One European option on `underlying`: the underlying's venue, currency and
 * sector, lot size 1, the futures multiplier, and a Black-76 reference price
 * at `vol` from the underlying's reference price carried to expiry.
 */
export const toOptionDef = (
  underlying: InstrumentDef,
  putCall: PutCall,
  strike: number,
  expiry: number,
  now: number,
  {
    carryRate = DEFAULT_OPTIONS_OPTIONS.carryRate,
    vol = DEFAULT_OPTIONS_OPTIONS.vol,
    liquid = false,
  }: { carryRate?: number; vol?: number; liquid?: boolean } = {},
): InstrumentDef => {
  const tickSize = optionTick(underlying);
  const date = new Date(expiry);
  const price = black76Price({
    putCall,
    forward: carriedPrice(underlying.refPrice, carryRate, expiry, now),
    strike,
    years: yearsToExpiry(expiry, now),
    vol,
  });
  return {
    ric: optionRic(underlying.ric, putCall, strike, expiry),
    description: `${underlying.description} ${MONTH_NAMES[date.getUTCMonth()]} ${date.getUTCFullYear()} ${strike} ${putCall === PutCall.Call ? "call" : "put"}`,
    currency: underlying.currency,
    exchange: underlying.exchange,
    sector: underlying.sector,
    instrumentType: InstrumentType.Option,
    underlying: underlying.ric,
    expiry,
    putCall,
    strike,
    liquid,
    contractMultiplier: contractMultiplierFor(underlying),
    tickSize,
    tickBands: "",
    lotSize: 1,
    priceDecimals: decimalsOf(tickSize),
    // at least one tick: a far wing is never quoted at zero
    refPrice: Math.max(tickSize, roundToTick(price, tickSize)),
    usdPerPriceUnit: underlying.usdPerPriceUnit,
  };
};

/**
 * The option chain on each underlying: `expiries` monthly expiries, calls
 * and puts on `strikes` strikes each side of at-the-money. The nearest
 * `bookStrikes` each side, in the first `bookExpiries` expiries, are liquid.
 * Throws on an unknown underlying or one that is neither an equity nor an
 * index.
 */
export const listOptions = (
  universe: readonly InstrumentDef[],
  underlyings: readonly string[],
  now: number,
  options: Partial<OptionsOptions> = {},
): InstrumentDef[] => {
  const o = { ...DEFAULT_OPTIONS_OPTIONS, ...options };
  if (underlyings.length === 0 || o.expiries <= 0) return [];
  const byRic = new Map(universe.map((i) => [i.ric, i]));
  const expiries = monthlyExpiries(now, o.expiries, o.expiryTime);
  const listed: InstrumentDef[] = [];
  for (const ric of new Set(underlyings)) {
    const underlying = byRic.get(ric);
    if (!underlying)
      throw Error(`exchangeSim.options: unknown underlying ${ric}`);
    const type = underlying.instrumentType ?? InstrumentType.Equity;
    if (type !== InstrumentType.Equity && type !== InstrumentType.Index)
      throw Error(`exchangeSim.options: ${ric} is not an equity or an index`);
    const strikes = strikeGrid(underlying.refPrice, o.strikes);
    const centre = strikes.indexOf(
      strikes.reduce((a, b) =>
        Math.abs(b - underlying.refPrice) < Math.abs(a - underlying.refPrice)
          ? b
          : a,
      ),
    );
    for (const [e, expiry] of expiries.entries()) {
      for (const [s, strike] of strikes.entries()) {
        const liquid =
          e < o.bookExpiries && Math.abs(s - centre) <= o.bookStrikes;
        for (const putCall of [PutCall.Call, PutCall.Put]) {
          listed.push(
            toOptionDef(underlying, putCall, strike, expiry, now, {
              carryRate: o.carryRate,
              vol: o.vol,
              liquid,
            }),
          );
        }
      }
    }
  }
  for (const option of listed) {
    const clash = byRic.get(option.ric);
    if (clash)
      throw Error(
        `exchangeSim.options: ${option.ric} (${option.underlying}) clashes with ${clash.underlying ?? clash.ric}`,
      );
    byRic.set(option.ric, option);
  }
  return listed;
};

/** Whether an instrument is an option. */
export const isOption = (instrument: InstrumentDef) =>
  instrument.instrumentType === InstrumentType.Option;
