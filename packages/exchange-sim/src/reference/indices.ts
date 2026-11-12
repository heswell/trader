import { InstrumentType } from "@heswell/trading-schemas";
import type { InstrumentDef } from "./instruments";

/** Level of every synthetic index at its constituents' reference prices. */
export const INDEX_BASE = 1000;

/** A synthetic index: an equal-weighted basket of universe equities. */
export interface IndexSpec {
  ric: string;
  description: string;
  constituents: readonly string[];
}

/**
 * The synthetic indices. Names are generic (not real index brands); each is
 * single currency, so its points carry the constituents' USD rate.
 */
export const SYNTHETIC_INDICES: readonly IndexSpec[] = [
  {
    ric: "STECH",
    description: "Sim US Tech index",
    constituents: [
      "AAPL.OQ",
      "MSFT.OQ",
      "NVDA.OQ",
      "AMZN.OQ",
      "GOOGL.OQ",
      "META.OQ",
      "TSLA.OQ",
      "AVGO.OQ",
    ],
  },
  {
    ric: "SUK",
    description: "Sim UK large cap index",
    constituents: [
      "AZN.L",
      "HSBA.L",
      "ULVR.L",
      "BP.L",
      "GSK.L",
      "RIO.L",
      "DGE.L",
      "BATS.L",
      "VOD.L",
      "LLOY.L",
    ],
  },
];

const SPEC_BY_RIC = new Map(SYNTHETIC_INDICES.map((s) => [s.ric, s]));

/** Whether `ric` names a synthetic index. */
export const isIndexRic = (ric: string) => SPEC_BY_RIC.has(ric);

/** Whether an instrument is an index. */
export const isIndex = (instrument: InstrumentDef) =>
  instrument.instrumentType === InstrumentType.Index;

/**
 * Static data of an index: listed (not tradeable) at the constituents'
 * venue and currency, a 0.01 point tick, base level INDEX_BASE.
 */
export const toIndexDef = (
  spec: IndexSpec,
  universe: readonly InstrumentDef[],
): InstrumentDef => {
  const byRic = new Map(universe.map((i) => [i.ric, i]));
  const constituents = spec.constituents.map((ric) => {
    const c = byRic.get(ric);
    if (!c)
      throw Error(
        `exchangeSim.indices: ${spec.ric} constituent ${ric} unknown`,
      );
    return c;
  });
  const [first] = constituents;
  if (!first)
    throw Error(`exchangeSim.indices: ${spec.ric} has no constituents`);
  const odd = constituents.find((c) => c.currency !== first.currency);
  if (odd)
    throw Error(
      `exchangeSim.indices: ${spec.ric} mixes ${first.currency} and ${odd.currency}`,
    );
  return {
    ric: spec.ric,
    description: spec.description,
    currency: first.currency,
    exchange: first.exchange,
    sector: "",
    instrumentType: InstrumentType.Index,
    constituents: [...spec.constituents],
    contractMultiplier: 1,
    tickSize: 0.01,
    tickBands: "",
    lotSize: 1,
    priceDecimals: 2,
    refPrice: INDEX_BASE,
    usdPerPriceUnit: first.usdPerPriceUnit,
  };
};

/**
 * Index defs for the named rics (deduplicated, in order). Throws on a name
 * that is not a synthetic index.
 */
export const listIndices = (
  universe: readonly InstrumentDef[],
  rics: readonly string[],
): InstrumentDef[] =>
  [...new Set(rics)].map((ric) => {
    const spec = SPEC_BY_RIC.get(ric);
    if (!spec)
      throw Error(
        `exchangeSim.indices: unknown index ${ric} (${[...SPEC_BY_RIC.keys()].join(", ")})`,
      );
    return toIndexDef(spec, universe);
  });

/**
 * Equal-weighted level: INDEX_BASE times the mean of each constituent's
 * price relative to its reference price.
 */
export const indexLevel = (
  refs: readonly number[],
  prices: readonly number[],
) => {
  if (refs.length === 0) return INDEX_BASE;
  let sum = 0;
  for (let i = 0; i < refs.length; i++) sum += prices[i] / refs[i];
  return (INDEX_BASE * sum) / refs.length;
};

/**
 * Add each index's constituents to an active set (after it, without
 * duplicates). Indices themselves get no book.
 */
export const withConstituents = (
  active: readonly InstrumentDef[],
  indices: readonly InstrumentDef[],
  universe: readonly InstrumentDef[],
): InstrumentDef[] => {
  const byRic = new Map(universe.map((i) => [i.ric, i]));
  const result = [...active];
  const have = new Set(result.map((i) => i.ric));
  for (const index of indices) {
    for (const ric of index.constituents ?? []) {
      const c = byRic.get(ric);
      if (c && !have.has(ric)) {
        result.push(c);
        have.add(ric);
      }
    }
  }
  return result;
};
