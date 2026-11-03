import type { TradingRow } from "../../data/useDataSourceRows";
import { useTradingRows } from "../../data/useTradingRows";
import { filterString } from "../../utils/filters";
import type { formatPrice } from "../../utils/formatting";
import { useMemo } from "react";

export interface ChannelPrice {
  last?: number;
  changePct?: number;
  phase?: string;
  /** The instrument's price format, as the search dropdown uses. */
  format: Parameters<typeof formatPrice>[1];
}

const PRICE_COLUMNS = [
  "ric",
  "last",
  "changePct",
  "phase",
  "priceDecimals",
  "tickSize",
  "tickBands",
];

const num = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** Live last / change / phase and price format of `rics`, by ric. */
export const useChannelPrices = (
  rics: readonly string[],
): ReadonlyMap<string, ChannelPrice> => {
  const unique = [...new Set(rics)].sort();
  const key = unique.join("|");
  // biome-ignore lint/correctness/useExhaustiveDependencies: key stands in for unique
  const filter = useMemo(
    () =>
      unique.length > 0
        ? `ric in [${unique.map(filterString).join(",")}]`
        : undefined,
    [key],
  );
  const { rows } = useTradingRows("instrumentPrices", {
    columns: PRICE_COLUMNS,
    enabled: filter !== undefined,
    filter,
    rowCount: 16,
  });
  return useMemo(
    () =>
      new Map(
        rows.map((row: TradingRow) => [
          String(row.ric),
          {
            last: num(row.last),
            changePct: num(row.changePct),
            phase: typeof row.phase === "string" ? row.phase : undefined,
            format: {
              priceDecimals: num(row.priceDecimals),
              tickSize: num(row.tickSize),
              tickBands: (row.tickBands as string | undefined) || undefined,
            },
          },
        ]),
      ),
    [rows],
  );
};
