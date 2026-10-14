import {
  decimalsOf,
  type InstrumentStatic,
  parseTickBands,
  roundToTick,
  type TickSchedule,
  tickSizeAt,
} from "@heswell/trading-schemas";
import { SECTOR_BY_RIC } from "./sectors";
import { UNIVERSE, type UniverseRow } from "./universe";

/** Static data of a simulated (or listed but inactive) instrument. */
export interface InstrumentDef extends InstrumentStatic {
  description: string;
  /** GICS sector ("" if unknown). */
  sector: string;
  tickBands: string;
  priceDecimals: number;
  refPrice: number;
  /** USD value of one unit of price (GBX prices are in pence). */
  usdPerPriceUnit: number;
}

/** Venue conventions: tick schedules (MiFID II style bands for Europe) and lots. */
const EU_BANDS =
  "0:0.0001;0.5:0.0005;1:0.001;5:0.005;10:0.01;50:0.05;100:0.1;500:0.5;1000:1;5000:5";
const HK_BANDS =
  "0:0.001;0.25:0.005;0.5:0.01;10:0.02;20:0.05;100:0.1;200:0.2;500:0.5;1000:1;2000:2;5000:5";

const TICK_BANDS: Record<string, string> = {
  XLON: EU_BANDS,
  XETR: EU_BANDS,
  XPAR: EU_BANDS,
  XAMS: EU_BANDS,
  XMIL: EU_BANDS,
  XSWX: EU_BANDS,
  XHKG: HK_BANDS,
};

const USD_RATE: Record<string, number> = {
  USD: 1,
  GBX: 0.0127,
  EUR: 1.08,
  CHF: 1.12,
  HKD: 0.128,
};

/** HKEX board lots vary per stock; derive a plausible one from the price. */
const hkBoardLot = (price: number) =>
  price < 5 ? 2000 : price < 20 ? 1000 : price < 100 ? 500 : 100;

export const toInstrumentDef = ([
  ric,
  description,
  currency,
  exchange,
  rawPrice,
]: UniverseRow): InstrumentDef => {
  const tickBands = TICK_BANDS[exchange] ?? "";
  const schedule: TickSchedule = parseTickBands(tickBands) ?? 0.01;
  const refPrice = roundToTick(rawPrice, schedule);
  const tickSize = tickSizeAt(schedule, refPrice);
  return {
    ric,
    description,
    currency,
    exchange,
    sector: SECTOR_BY_RIC.get(ric) ?? "",
    tickSize,
    tickBands,
    lotSize: exchange === "XHKG" ? hkBoardLot(refPrice) : 1,
    // enough decimals for the smallest tick reachable within a ±50% move
    priceDecimals: Math.max(
      decimalsOf(tickSize),
      decimalsOf(tickSizeAt(schedule, refPrice * 0.5)),
    ),
    refPrice,
    usdPerPriceUnit: USD_RATE[currency] ?? 1,
  };
};

export const ALL_INSTRUMENTS: readonly InstrumentDef[] =
  UNIVERSE.map(toInstrumentDef);

/**
 * Pick the active (simulated) set. An explicit ric list wins; otherwise the
 * first `count` instruments taken round-robin across venues, so a small
 * universe still covers every tick regime.
 */
export const selectActiveInstruments = (
  all: readonly InstrumentDef[],
  count: number,
  rics?: readonly string[],
): InstrumentDef[] => {
  if (rics && rics.length > 0) {
    const byRic = new Map(all.map((i) => [i.ric, i]));
    return rics.map((ric) => {
      const instrument = byRic.get(ric);
      if (!instrument) throw Error(`exchangeSim: unknown instrument ${ric}`);
      return instrument;
    });
  }
  const venues = new Map<string, InstrumentDef[]>();
  for (const instrument of all) {
    const list = venues.get(instrument.exchange) ?? [];
    list.push(instrument);
    venues.set(instrument.exchange, list);
  }
  const queues = [...venues.values()];
  const selected: InstrumentDef[] = [];
  for (let i = 0; selected.length < Math.min(count, all.length); i++) {
    for (const queue of queues) {
      if (i < queue.length && selected.length < count) selected.push(queue[i]);
    }
  }
  return selected;
};
