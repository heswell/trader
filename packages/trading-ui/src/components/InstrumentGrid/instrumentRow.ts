import type { SelectedInstrument } from "../../instrument-context/selectedInstrument";

/** A grid data row (or context menu `dataRow`). */
export type InstrumentRow = {
  [key: string]: unknown;
  hasColumn?: (name: string) => boolean;
};

/**
 * The instrument of a grid row, with the static fields the row has (a
 * `prices` row has none of description, currency, ...).
 */
export const toInstrument = (row: InstrumentRow): SelectedInstrument => {
  const get = (name: string) =>
    row.hasColumn && !row.hasColumn(name) ? undefined : row[name];
  const num = (name: string) => {
    const v = get(name);
    return v === undefined || v === "" || v === null ? undefined : Number(v);
  };
  const str = (name: string) => {
    const v = get(name);
    return v === undefined || v === null ? undefined : String(v);
  };
  return {
    ric: String(row.ric),
    description: str("description"),
    currency: str("currency"),
    exchange: str("exchange"),
    tickSize: num("tickSize"),
    tickBands: str("tickBands"),
    lotSize: num("lotSize"),
    priceDecimals: num("priceDecimals"),
    contractMultiplier: num("contractMultiplier"),
  };
};
