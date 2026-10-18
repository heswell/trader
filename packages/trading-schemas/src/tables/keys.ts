import type { Side } from "../domain/enums";

const SEP = "|";

/** Key of a `depth` row. */
export const depthKey = (ric: string, side: Side, level: number) =>
  `${ric}${SEP}${side}${SEP}${level}`;

/**
 * Splits a `depth` row key into ric, side and level (inverse of depthKey);
 * throws if malformed.
 */
export const parseDepthKey = (key: string) => {
  const parts = key.split(SEP);
  if (parts.length !== 3) throw Error(`invalid depth key '${key}'`);
  const [ric, side, level] = parts;
  return { ric, side: side as Side, level: Number(level) };
};

/** Key of a `positions` row. */
export const positionKey = (account: string, ric: string) =>
  `${account}${SEP}${ric}`;

/**
 * Splits a `positions` row key into account and ric (inverse of positionKey);
 * throws if malformed.
 */
export const parsePositionKey = (key: string) => {
  const parts = key.split(SEP);
  if (parts.length !== 2) throw Error(`invalid position key '${key}'`);
  const [account, ric] = parts;
  return { account, ric };
};

/** Key of a `bars` row. */
export const barKey = (ric: string, interval: string, start: number) =>
  `${ric}${SEP}${interval}${SEP}${start}`;

/** Key of a `bookSamples` row. */
export const bookSampleKey = (ric: string, time: number) =>
  `${ric}${SEP}${time}`;

/** Key of a `pnlHistory` row. */
export const pnlHistoryKey = (account: string, ric: string, time: number) =>
  `${account}${SEP}${ric}${SEP}${time}`;

/** Key of an `accountPnlHistory` row. */
export const accountPnlHistoryKey = (account: string, time: number) =>
  `${account}${SEP}${time}`;

const INTERVAL_UNITS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
};

/**
 * Bar interval label -> milliseconds, e.g. "1s" -> 1000, "5m" -> 300000.
 * Units: s, m, h. Throws if malformed.
 */
export const parseBarInterval = (interval: string) => {
  const match = /^(\d+)([smh])$/.exec(interval.trim());
  const ms = match ? Number(match[1]) * INTERVAL_UNITS[match[2]] : 0;
  if (!(ms > 0)) throw Error(`invalid bar interval '${interval}'`);
  return ms;
};
