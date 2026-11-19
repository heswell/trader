import { PutCall } from "@heswell/trading-schemas";
import type { TradingRow } from "../../data/useDataSourceRows";
import type { SelectedInstrument } from "../../instrument-context/selectedInstrument";

/** One option of a chain: its terms, quote and analytics. */
export interface ChainOption {
  ric: string;
  underlying: string;
  putCall: PutCall;
  strike: number;
  expiry: number;
  /** True when the strike has a book; quote-only strikes take no orders. */
  liquid: boolean;
  bid?: number;
  ask?: number;
  last?: number;
  phase?: string;
  /** Implied vol from the mid (optionAnalytics), as priced on the sim clock. */
  impliedVol?: number;
  delta?: number;
  theo?: number;
  /** Static data, to select the option or open a ticket on it. */
  instrument: SelectedInstrument;
}

/** A strike of one expiry: its call and its put. */
export interface ChainStrike {
  strike: number;
  call?: ChainOption;
  put?: ChainOption;
}

export interface OptionChainData {
  /** Underlyings of the chain's options (one, unless a root matched more). */
  underlyings: string[];
  /** Listed expiries, nearest first. */
  expiries: number[];
  /** Strikes per expiry, lowest first. */
  strikes: ReadonlyMap<number, ChainStrike[]>;
  /** Forward per expiry (optionAnalytics), for the at-the-money strike. */
  forwards: ReadonlyMap<number, number>;
  byRic: ReadonlyMap<string, ChainOption>;
}

export const EMPTY_CHAIN: OptionChainData = Object.freeze({
  underlyings: [],
  expiries: [],
  strikes: new Map(),
  forwards: new Map(),
  byRic: new Map(),
});

/** Columns of instrumentPrices the chain reads. */
export const CHAIN_INSTRUMENT_COLUMNS = [
  "ric",
  "description",
  "currency",
  "exchange",
  "tickSize",
  "tickBands",
  "lotSize",
  "priceDecimals",
  "contractMultiplier",
  "underlying",
  "putCall",
  "strike",
  "expiry",
  "liquid",
  "bid",
  "ask",
  "last",
  "phase",
];

/** Columns of optionAnalytics the chain reads. */
export const CHAIN_ANALYTICS_COLUMNS = [
  "ric",
  "underlying",
  "forward",
  "theo",
  "impliedVol",
  "delta",
];

const quote = (text: string) => `"${text.replace(/["\\]/g, "")}"`;

/**
 * Vuu filter of the options on `underlying`: a ric (AAPL.OQ, STECH) or the
 * root of one (AAPL matches AAPL.OQ). Undefined for no underlying.
 */
export const underlyingFilter = (underlying: string | undefined) => {
  const u = underlying?.trim().toUpperCase();
  if (!u) return undefined;
  return `(underlying = ${quote(u)} or underlying starts ${quote(`${u}.`)})`;
};

const num = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value)
    ? value
    : typeof value === "string" && value !== "" && Number.isFinite(+value)
      ? +value
      : undefined;
const positive = (value: unknown) => {
  const n = num(value);
  return n !== undefined && n > 0 ? n : undefined;
};
const str = (value: unknown) =>
  value === undefined || value === null || value === ""
    ? undefined
    : String(value);

/**
 * The chain from instrumentPrices option rows and optionAnalytics rows
 * (joined on ric). Expired options (settled, or past expiry at `now`) are
 * left out.
 */
export const buildOptionChain = (
  instrumentRows: readonly TradingRow[],
  analyticsRows: readonly TradingRow[],
  now = Date.now(),
): OptionChainData => {
  if (instrumentRows.length === 0) return EMPTY_CHAIN;
  const analytics = new Map(analyticsRows.map((row) => [String(row.ric), row]));
  const byRic = new Map<string, ChainOption>();
  const strikes = new Map<number, Map<number, ChainStrike>>();
  const forwards = new Map<number, number>();
  const underlyings = new Set<string>();
  for (const row of instrumentRows) {
    const strike = num(row.strike);
    const expiry = num(row.expiry);
    const putCall = row.putCall === PutCall.Put ? PutCall.Put : PutCall.Call;
    if (strike === undefined || expiry === undefined || expiry <= now) continue;
    const ric = String(row.ric);
    const a = analytics.get(ric);
    const option: ChainOption = {
      ric,
      underlying: String(row.underlying ?? ""),
      putCall,
      strike,
      expiry,
      liquid: row.liquid === true || row.liquid === "true",
      bid: positive(row.bid),
      ask: positive(row.ask),
      last: positive(row.last),
      phase: str(row.phase),
      impliedVol: positive(a?.impliedVol),
      delta: num(a?.delta),
      theo: num(a?.theo),
      instrument: {
        ric,
        description: str(row.description),
        currency: str(row.currency),
        exchange: str(row.exchange),
        tickSize: num(row.tickSize),
        tickBands: str(row.tickBands),
        lotSize: num(row.lotSize),
        priceDecimals: num(row.priceDecimals),
        contractMultiplier: positive(row.contractMultiplier),
      },
    };
    byRic.set(ric, option);
    underlyings.add(option.underlying);
    const forward = positive(a?.forward);
    if (forward !== undefined) forwards.set(expiry, forward);
    let expiryStrikes = strikes.get(expiry);
    if (!expiryStrikes) {
      expiryStrikes = new Map();
      strikes.set(expiry, expiryStrikes);
    }
    const entry = expiryStrikes.get(strike) ?? { strike };
    if (putCall === PutCall.Call) entry.call = option;
    else entry.put = option;
    expiryStrikes.set(strike, entry);
  }
  const expiries = [...strikes.keys()].sort((a, b) => a - b);
  return {
    underlyings: [...underlyings].sort(),
    expiries,
    strikes: new Map(
      expiries.map((expiry) => [
        expiry,
        [...(strikes.get(expiry)?.values() ?? [])].sort(
          (a, b) => a.strike - b.strike,
        ),
      ]),
    ),
    forwards,
    byRic,
  };
};

/** The strike nearest `forward` (undefined without strikes or forward). */
export const atmStrike = (
  strikes: readonly ChainStrike[],
  forward: number | undefined,
) => {
  if (forward === undefined || strikes.length === 0) return undefined;
  let best = strikes[0];
  for (const s of strikes) {
    if (Math.abs(s.strike - forward) < Math.abs((best?.strike ?? 0) - forward))
      best = s;
  }
  return best?.strike;
};

const sideOf = (s: ChainStrike | undefined, putCall: PutCall) =>
  putCall === PutCall.Call ? s?.call : s?.put;

/**
 * The option `steps` strikes from `ric` (+ higher, - lower), same expiry
 * and right; clamped to the listed strikes. Undefined if `ric` is not in
 * the chain.
 */
export const stepStrike = (
  chain: OptionChainData,
  ric: string,
  steps: number,
): ChainOption | undefined => {
  const option = chain.byRic.get(ric);
  if (!option) return undefined;
  const strikes = (chain.strikes.get(option.expiry) ?? []).filter((s) =>
    sideOf(s, option.putCall),
  );
  const i = strikes.findIndex((s) => s.strike === option.strike);
  const next = strikes[Math.max(0, Math.min(strikes.length - 1, i + steps))];
  return sideOf(next, option.putCall) ?? option;
};

/**
 * The option on the strike nearest `strike` of `expiry` (and right).
 */
const nearestOn = (
  chain: OptionChainData,
  expiry: number,
  putCall: PutCall,
  strike: number,
  accept: (o: ChainOption) => boolean = () => true,
) => {
  let best: ChainOption | undefined;
  for (const s of chain.strikes.get(expiry) ?? []) {
    const o = sideOf(s, putCall);
    if (!o || !accept(o)) continue;
    if (!best || Math.abs(o.strike - strike) < Math.abs(best.strike - strike))
      best = o;
  }
  return best;
};

/** The option `steps` expiries from `ric`, on the nearest strike. */
export const stepExpiry = (
  chain: OptionChainData,
  ric: string,
  steps: number,
): ChainOption | undefined => {
  const option = chain.byRic.get(ric);
  if (!option) return undefined;
  const i = chain.expiries.indexOf(option.expiry);
  const expiry =
    chain.expiries[Math.max(0, Math.min(chain.expiries.length - 1, i + steps))];
  if (expiry === undefined) return option;
  return nearestOn(chain, expiry, option.putCall, option.strike) ?? option;
};

/** The same strike and expiry, the other right (call <-> put). */
export const otherRight = (chain: OptionChainData, ric: string) => {
  const option = chain.byRic.get(ric);
  if (!option) return undefined;
  const s = chain.strikes
    .get(option.expiry)
    ?.find((x) => x.strike === option.strike);
  return sideOf(
    s,
    option.putCall === PutCall.Call ? PutCall.Put : PutCall.Call,
  );
};

/** The liquid strike nearest a quote-only option (same expiry and right). */
export const nearestLiquid = (chain: OptionChainData, ric: string) => {
  const option = chain.byRic.get(ric);
  if (!option) return undefined;
  if (option.liquid) return option;
  return nearestOn(
    chain,
    option.expiry,
    option.putCall,
    option.strike,
    (o) => o.liquid,
  );
};

// ------------------------------------------------------------ typed specs

/** An option as typed: `AAPL 200c`, `aapl.oq 200p jan`, `stech 4100c dec27`. */
export interface OptionSpec {
  /** A ric or its root, upper case (AAPL, AAPL.OQ, STECH). */
  underlying: string;
  strike: number;
  putCall: PutCall;
  /** Month 0-11; absent = the front expiry. */
  month?: number;
  /** Two- or four-digit year typed with the month (dec27). */
  year?: number;
}

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

/** `200c` / `102.5p`: a strike and a right. */
export const STRIKE_WORD = /^(\d+(?:\.\d+)?)([cp])$/i;
/** `jan`, `jan27`, `january`, `sept2027`. */
const MONTH_WORD = /^([a-z]{3,9})(\d{2}|\d{4})?$/i;

/** Month (0-11) and year of a month word, if it is one. */
export const parseMonthWord = (word: string) => {
  const match = MONTH_WORD.exec(word);
  if (!match) return undefined;
  const letters = (match[1] ?? "").toLowerCase();
  const month = MONTHS.findIndex((name) => name.startsWith(letters));
  if (month < 0) return undefined;
  const y = match[2] ? Number(match[2]) : undefined;
  return { month, year: y === undefined ? undefined : y < 100 ? 2000 + y : y };
};

/** A strike word's strike and right (`200c`), if it is one. */
export const parseStrikeWord = (word: string) => {
  const match = STRIKE_WORD.exec(word);
  if (!match) return undefined;
  return {
    strike: Number(match[1]),
    putCall:
      (match[2] ?? "").toLowerCase() === "p" ? PutCall.Put : PutCall.Call,
  };
};

/** A word that can name an underlying: AAPL, aapl.oq, STECH. */
export const UNDERLYING_WORD = /^[a-z][a-z0-9]*(\.[a-z0-9]+)?$/i;

/**
 * Parse an option typed on its own: underlying, strike word, optional
 * month (`AAPL 200c`, `aapl 200p jan`). Undefined if it is not one.
 */
export const parseOptionSpec = (text: string): OptionSpec | undefined => {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 3) return undefined;
  const [u, k, m] = words as [string, string, string | undefined];
  const strike = parseStrikeWord(k);
  if (!UNDERLYING_WORD.test(u) || !strike) return undefined;
  const month = m === undefined ? undefined : parseMonthWord(m);
  if (m !== undefined && !month) return undefined;
  return {
    underlying: u.toUpperCase(),
    ...strike,
    ...(month ? { month: month.month } : {}),
    ...(month?.year !== undefined ? { year: month.year } : {}),
  };
};

/** Short text of a spec (`AAPL 200 call jan`), for notices. */
export const formatOptionSpec = (spec: OptionSpec) =>
  `${spec.underlying} ${spec.strike} ${spec.putCall === PutCall.Call ? "call" : "put"}${
    spec.month !== undefined
      ? ` ${MONTHS[spec.month]?.slice(0, 3)}${spec.year !== undefined ? ` ${spec.year}` : ""}`
      : ""
  }`;

/**
 * The listed option a spec names: the front expiry (or the first in the
 * month typed), exactly that strike and right.
 */
export const resolveOptionSpec = (
  chain: OptionChainData,
  spec: OptionSpec,
): ChainOption | undefined => {
  const expiry = chain.expiries.find((e) => {
    if (spec.month === undefined) return true;
    const d = new Date(e);
    return (
      d.getUTCMonth() === spec.month &&
      (spec.year === undefined || d.getUTCFullYear() === spec.year)
    );
  });
  if (expiry === undefined) return undefined;
  const s = chain.strikes.get(expiry)?.find((x) => x.strike === spec.strike);
  return sideOf(s, spec.putCall);
};

/** `20 Nov`, or `15 Jan 27` outside the current year. */
export const formatExpiry = (expiry: number, now = Date.now()) => {
  const d = new Date(expiry);
  const sameYear = d.getUTCFullYear() === new Date(now).getUTCFullYear();
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "2-digit" }),
    timeZone: "UTC",
  });
};
