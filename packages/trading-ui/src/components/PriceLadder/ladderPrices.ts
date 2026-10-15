import {
  roundToTick,
  stepTicks,
  type TickSchedule,
} from "@heswell/trading-schemas";

/**
 * Prices of the ladder rows, top (highest) first: `rowCount` rows on tick
 * increments with `centre` at index `centreIndex(rowCount)`. Band-aware.
 */
export const ladderPrices = (
  centre: number,
  schedule: TickSchedule,
  rowCount: number,
): number[] => {
  const prices: number[] = new Array(rowCount);
  if (rowCount <= 0) return [];
  let price = stepTicks(
    roundToTick(centre, schedule),
    schedule,
    centreIndex(rowCount),
  );
  for (let i = 0; i < rowCount; i++) {
    prices[i] = price;
    price = stepTicks(price, schedule, -1);
  }
  return prices;
};

/** Index of the centre row of a ladder of `rowCount` rows. */
export const centreIndex = (rowCount: number) => Math.floor(rowCount / 2);

/**
 * The price the ladder centres on: mid (rounded to tick), else best bid /
 * ask, else last, else `fallback` (e.g. close / refPrice).
 */
export const ladderReferencePrice = (
  schedule: TickSchedule,
  {
    bestBid,
    bestAsk,
    last,
    fallback,
  }: {
    bestBid?: number;
    bestAsk?: number;
    last?: number;
    fallback?: number;
  },
): number | undefined => {
  const valid = (p: number | undefined): p is number =>
    typeof p === "number" && Number.isFinite(p) && p > 0;
  if (valid(bestBid) && valid(bestAsk)) {
    return roundToTick((bestBid + bestAsk) / 2, schedule, "down");
  }
  const price = [bestBid, bestAsk, last, fallback].find(valid);
  return price === undefined ? undefined : roundToTick(price, schedule);
};

/**
 * True when `reference` sits outside the middle half of the visible rows,
 * i.e. auto-centre should move the ladder.
 */
export const needsRecentre = (prices: readonly number[], reference: number) => {
  if (prices.length === 0) return true;
  const quarter = Math.floor(prices.length / 4);
  const high = prices[quarter];
  const low = prices[prices.length - 1 - quarter];
  return reference > high || reference < low;
};
