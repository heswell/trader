import { Side, type TradingPhase } from "@heswell/trading-schemas";
import { useMemo } from "react";
import {
  type SelectedInstrument,
  useSelectedInstrument,
} from "../instrument-context/InstrumentContext";
import { useTradingDataSource } from "../data/useTradingDataSource";
import { filterString, useViewportRows } from "./useViewportRows";

/** Normalised numeric key for a price (avoids float noise in Map lookups). */
export const priceKey = (price: number) => Number(price.toFixed(8));

export interface DepthLevel {
  side: Side;
  /** 0 = best. */
  level: number;
  price: number;
  size: number;
  cumSize: number;
  orderCount: number;
}

export interface MarketDepthState {
  ric: string | undefined;
  /** Best first (highest price). */
  bids: DepthLevel[];
  /** Best first (lowest price). */
  asks: DepthLevel[];
  loaded: boolean;
  version: number;
}

const byLevel = (a: DepthLevel, b: DepthLevel) => a.level - b.level;

/**
 * The aggregated book (EXCHANGE `depth`) for one instrument, split into
 * bids and asks, best first. `levels` caps the levels per side (the table
 * carries `exchangeSim.depthLevels`, 10 by default). Rows of a previous
 * `ric` are never returned.
 */
export const useMarketDepth = (
  ric: string | undefined,
  { levels = 10 }: { levels?: number } = {},
): MarketDepthState => {
  const dataSource = useTradingDataSource("depth", {
    columns: ["ric", "side", "level", "price", "size", "cumSize", "orderCount"],
  });
  const { rows, loaded, version } = useViewportRows(dataSource, {
    enabled: !!ric,
    filter: ric ? `ric = ${filterString(ric)} and level < ${levels}` : "",
    maxRows: levels * 2 + 2,
  });
  return useMemo(() => {
    const bids: DepthLevel[] = [];
    const asks: DepthLevel[] = [];
    for (const row of rows) {
      if (row.ric !== ric) continue;
      const level = row as unknown as DepthLevel;
      if (level.level >= levels) continue;
      if (row.side === Side.Buy) bids.push(level);
      else if (row.side === Side.Sell) asks.push(level);
    }
    bids.sort(byLevel);
    asks.sort(byLevel);
    return { ric, bids, asks, loaded, version };
  }, [rows, ric, levels, loaded, version]);
};

/** Live price row (EXCHANGE `instrumentPrices`): static + market data. */
export interface InstrumentPrice extends SelectedInstrument {
  bid?: number;
  ask?: number;
  bidSize?: number;
  askSize?: number;
  last?: number;
  lastSize?: number;
  close?: number;
  refPrice?: number;
  volume?: number;
  phase?: TradingPhase | string;
}

/**
 * The `instrumentPrices` row of one instrument (static data plus live
 * bid/ask/last/phase), or undefined until it arrives.
 */
export const useInstrumentPrice = (
  ric: string | undefined,
): InstrumentPrice | undefined => {
  const dataSource = useTradingDataSource("instrumentPrices", {
    columns: [
      "ric",
      "description",
      "currency",
      "exchange",
      "tickSize",
      "tickBands",
      "lotSize",
      "priceDecimals",
      "refPrice",
      "bid",
      "ask",
      "bidSize",
      "askSize",
      "last",
      "lastSize",
      "close",
      "volume",
      "phase",
    ],
  });
  const { rows } = useViewportRows(dataSource, {
    enabled: !!ric,
    filter: ric ? `ric = ${filterString(ric)}` : "",
    maxRows: 1,
  });
  const row = rows[0];
  return useMemo(() => {
    if (!row || row.ric !== ric) return undefined;
    const { $key: _key, tickBands, ...rest } = row;
    return {
      ...rest,
      tickBands: typeof tickBands === "string" ? tickBands : undefined,
    } as InstrumentPrice;
  }, [row, ric]);
};

/**
 * Traded volume per price (EXCHANGE `trades` grouped by price, summed size)
 * for one instrument, keyed by `priceKey(price)`. Covers the trades still in
 * the exchange's ring buffer.
 */
export const useTradedVolume = (
  ric: string | undefined,
  { enabled = true, maxPrices = 500 } = {},
): Map<number, number> => {
  const dataSource = useTradingDataSource("trades", {
    columns: ["ric", "price", "size"],
  });
  const { rows } = useViewportRows(dataSource, {
    enabled: enabled && !!ric,
    filter: ric ? `ric = ${filterString(ric)}` : "",
    groupBy: GROUP_BY_PRICE,
    aggregations: SUM_SIZE,
    maxRows: maxPrices,
  });
  return useMemo(() => {
    const volume = new Map<number, number>();
    for (const row of rows) {
      if (typeof row.price === "number" && typeof row.size === "number") {
        volume.set(priceKey(row.price), row.size);
      }
    }
    return volume;
  }, [rows]);
};

const GROUP_BY_PRICE = ["price"];
// vuu aggType 1 = Sum
const SUM_SIZE = [{ column: "size", aggType: 1 as const }];

export interface FollowedInstrument {
  ric: string | undefined;
  /**
   * Static data (from the instrument context when it matches, else the
   * instrumentPrices row) merged with live prices / phase.
   */
  instrument: InstrumentPrice | undefined;
}

/**
 * The instrument a market-data component shows: the explicit `ric` prop
 * when given, else the selected instrument (useSelectedInstrument), with its
 * live instrumentPrices row.
 */
export const useFollowedInstrument = (
  ricOverride?: string,
): FollowedInstrument => {
  const { selectedInstrument } = useSelectedInstrument();
  const ric = ricOverride ?? selectedInstrument?.ric;
  const price = useInstrumentPrice(ric);
  const instrument = useMemo(() => {
    if (!ric) return undefined;
    const selected =
      selectedInstrument?.ric === ric ? selectedInstrument : undefined;
    if (!price && !selected) return { ric };
    return { ...price, ...stripUndefined(selected), ric } as InstrumentPrice;
  }, [ric, price, selectedInstrument]);
  return { ric, instrument };
};

const stripUndefined = <T extends object>(value: T | undefined) =>
  value
    ? (Object.fromEntries(
        Object.entries(value).filter(([, v]) => v !== undefined && v !== ""),
      ) as Partial<T>)
    : undefined;
