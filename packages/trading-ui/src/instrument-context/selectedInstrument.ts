/**
 * The instrument other components should follow. `ric` is the key; the
 * other fields are optional static data (from `instruments`) so consumers
 * can format prices / validate quantities without another lookup.
 */
export interface SelectedInstrument {
  ric: string;
  description?: string;
  currency?: string;
  exchange?: string;
  tickSize?: number;
  /** Tick bands, as in the instruments table (`from:tick;...`). */
  tickBands?: string;
  lotSize?: number;
  priceDecimals?: number;
}

const STRING_FIELDS = [
  "description",
  "currency",
  "exchange",
  "tickBands",
] as const;
const NUMBER_FIELDS = ["tickSize", "lotSize", "priceDecimals"] as const;

/**
 * A plain, JSON-safe copy of `value` with only the SelectedInstrument
 * fields (so grid rows, proxies or class instances never cross the bus).
 * Undefined if there is no usable ric (missing, not a string, blank).
 */
export const sanitizeSelectedInstrument = (
  value: unknown,
): SelectedInstrument | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  const ric = typeof source.ric === "string" ? source.ric.trim() : "";
  if (!ric) return undefined;
  const instrument: SelectedInstrument = { ric };
  for (const field of STRING_FIELDS) {
    const v = source[field];
    if (typeof v === "string" && v !== "") instrument[field] = v;
  }
  for (const field of NUMBER_FIELDS) {
    const v = source[field];
    if (typeof v === "number" && Number.isFinite(v)) instrument[field] = v;
  }
  return instrument;
};

export const sameInstrument = (
  a: SelectedInstrument | undefined,
  b: SelectedInstrument | undefined,
) => {
  if (a === b) return true;
  if (!a || !b) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (
      a[key as keyof SelectedInstrument] !== b[key as keyof SelectedInstrument]
    )
      return false;
  }
  return true;
};
