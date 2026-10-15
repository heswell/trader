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
