import { hashString, Random } from "../util/random";
import { Sector } from "./sectors";

/**
 * Simulated fundamentals of an equity, for stock screening. Not real data:
 * the universe and its reference prices are stale (circa 2015, some pre-split),
 * so real figures would give meaningless ratios against them. Instead each
 * stock gets values drawn from its sector's typical profile, seeded by ric
 * (deterministic, and independent of the rest of the universe) and consistent
 * with its refPrice. Price-dependent ratios (market cap, P/E, P/B, yield) are
 * derived from these inputs and the live price.
 */
export interface Fundamentals {
  /** Shares in issue. */
  sharesOutstanding: number;
  /** Trailing 12-month EPS in the price currency (pence for GBX). <0 = loss. */
  eps: number;
  /** Book value per share, price currency. */
  bookValuePerShare: number;
  /** Trailing 12-month dividend per share, price currency. */
  dividendPerShare: number;
  /** Return on equity, %: eps / bookValuePerShare. */
  roe: number;
}

interface SectorProfile {
  /** Median trailing P/E of profitable names. */
  pe: number;
  /** Median ROE, %. */
  roe: number;
  /** Median payout ratio (dividend / earnings) of dividend payers. */
  payout: number;
  /** Probability of a trailing loss. */
  lossChance: number;
  /** Probability a profitable name pays no dividend. */
  noDividendChance: number;
}

/** Approximate sector norms (general market knowledge, not a sourced dataset). */
// biome-ignore format: data table
export const SECTOR_PROFILES: Readonly<Record<Sector | "", SectorProfile>> = {
  [Sector.InformationTechnology]:  { pe: 28, roe: 25, payout: 0.15, lossChance: 0.06, noDividendChance: 0.4 },
  [Sector.ConsumerDiscretionary]:  { pe: 22, roe: 18, payout: 0.25, lossChance: 0.06, noDividendChance: 0.3 },
  [Sector.HealthCare]:             { pe: 22, roe: 18, payout: 0.35, lossChance: 0.08, noDividendChance: 0.2 },
  [Sector.ConsumerStaples]:        { pe: 21, roe: 20, payout: 0.6,  lossChance: 0.02, noDividendChance: 0.05 },
  [Sector.Industrials]:            { pe: 20, roe: 16, payout: 0.35, lossChance: 0.03, noDividendChance: 0.1 },
  [Sector.CommunicationServices]:  { pe: 18, roe: 14, payout: 0.3,  lossChance: 0.06, noDividendChance: 0.25 },
  [Sector.RealEstate]:             { pe: 18, roe: 6,  payout: 0.8,  lossChance: 0.06, noDividendChance: 0.05 },
  [Sector.Utilities]:              { pe: 16, roe: 9,  payout: 0.7,  lossChance: 0.02, noDividendChance: 0.02 },
  [Sector.Materials]:              { pe: 13, roe: 12, payout: 0.45, lossChance: 0.08, noDividendChance: 0.1 },
  [Sector.Energy]:                 { pe: 11, roe: 14, payout: 0.45, lossChance: 0.1,  noDividendChance: 0.05 },
  [Sector.Financials]:             { pe: 11, roe: 11, payout: 0.45, lossChance: 0.02, noDividendChance: 0.05 },
  "":                              { pe: 17, roe: 13, payout: 0.4,  lossChance: 0.05, noDividendChance: 0.15 },
};

/** Median market cap (USD) per venue; log-normal spread MARKET_CAP_SIGMA. */
export const MEDIAN_MARKET_CAP_USD: Readonly<Record<string, number>> = {
  XNAS: 80e9,
  XNYS: 80e9,
  XHKG: 25e9,
  XLON: 15e9,
  XETR: 50e9,
  XPAR: 50e9,
  XAMS: 50e9,
  XMIL: 50e9,
  XSWX: 50e9,
};
const DEFAULT_MEDIAN_CAP_USD = 20e9;
const MARKET_CAP_SIGMA = 0.8;
export const MIN_MARKET_CAP_USD = 1e9;
/** Ceiling for names not in MEGA_CAPS. */
export const MAX_MARKET_CAP_USD = 8e11;

/** Mega caps pinned to $1-3tn so the top of a cap-sorted screen looks right. */
export const MEGA_CAPS: ReadonlySet<string> = new Set([
  "AAPL.OQ",
  "MSFT.OQ",
  "NVDA.OQ",
  "AMZN.OQ",
  "GOOGL.OQ",
  "GOOG.OQ",
  "META.OQ",
  "AVGO.OQ",
  "TSLA.OQ",
]);

const PE_SIGMA = 0.35;
const ROE_SIGMA = 0.3;
/** A loss-maker's EPS: -refPrice / LOSS_PE_MULTIPLE. */
const LOSS_PE_MULTIPLE = 25;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const round = (value: number, decimals: number) => {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
};

export interface FundamentalsInput {
  ric: string;
  sector: string;
  exchange: string;
  /** Reference price in the price currency. */
  refPrice: number;
  /** USD value of one unit of the price currency. */
  usdPerPriceUnit: number;
}

/** Simulated fundamentals of one equity (deterministic per input). */
export const generateFundamentals = ({
  ric,
  sector,
  exchange,
  refPrice,
  usdPerPriceUnit,
}: FundamentalsInput): Fundamentals => {
  const rng = new Random((hashString(ric) ^ 0x5eed) >>> 0);
  const profile = SECTOR_PROFILES[sector as Sector] ?? SECTOR_PROFILES[""];
  // Every draw is taken up front, in a fixed order, whichever branch is used.
  const capDraw = rng.normal();
  const megaDraw = rng.next();
  const peDraw = rng.normal();
  const roeDraw = rng.normal();
  const payoutDraw = rng.normal();
  const loss = rng.chance(profile.lossChance);
  const noDividend = rng.chance(profile.noDividendChance);

  const marketCapUsd = MEGA_CAPS.has(ric)
    ? 1e12 * 3 ** megaDraw
    : clamp(
        (MEDIAN_MARKET_CAP_USD[exchange] ?? DEFAULT_MEDIAN_CAP_USD) *
          Math.exp(MARKET_CAP_SIGMA * capDraw),
        MIN_MARKET_CAP_USD,
        MAX_MARKET_CAP_USD,
      );
  const sharesOutstanding = Math.max(
    1,
    Math.round(marketCapUsd / (refPrice * usdPerPriceUnit)),
  );

  const pe = clamp(profile.pe * Math.exp(PE_SIGMA * peDraw), 4, 120);
  const roe = clamp(profile.roe * Math.exp(ROE_SIGMA * roeDraw), 1, 80) / 100;

  let eps: number;
  let bookValuePerShare: number;
  let dividendPerShare = 0;
  if (loss) {
    eps = -refPrice / LOSS_PE_MULTIPLE;
    // book value from the sector's typical P/B (= P/E x ROE)
    const pb = profile.pe * (profile.roe / 100) * Math.exp(ROE_SIGMA * roeDraw);
    bookValuePerShare = refPrice / Math.max(0.2, pb);
  } else {
    eps = refPrice / pe;
    bookValuePerShare = eps / roe;
    if (!noDividend) {
      const payout = clamp(profile.payout * (1 + 0.35 * payoutDraw), 0.05, 1.1);
      dividendPerShare = eps * payout;
    }
  }
  return {
    sharesOutstanding,
    eps: round(eps, 4),
    bookValuePerShare: round(bookValuePerShare, 4),
    dividendPerShare: round(dividendPerShare, 4),
    roe: round((100 * eps) / bookValuePerShare, 2),
  };
};
