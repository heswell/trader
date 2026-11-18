import { INSTRUMENT_TYPES } from "@heswell/trading-schemas";
import { quickFilterExpression } from "../InstrumentGrid/instrumentGridFilter";
import { filterString } from "../../utils/filters";

/** `instruments` columns the picker filters on, in the order shown. */
export const PICKER_FACETS = [
  { column: "sector", label: "Sector" },
  { column: "instrumentType", label: "Type" },
  { column: "exchange", label: "Exchange" },
  { column: "currency", label: "Currency" },
] as const;

export type PickerFacet = (typeof PICKER_FACETS)[number]["column"];

/** Selected values per facet; a missing or empty list = any value. */
export type PickerFacetValues = Partial<Record<PickerFacet, string[]>>;

/** Instrument types are an enum, so their options need no lookup. */
export const INSTRUMENT_TYPE_OPTIONS: readonly string[] = INSTRUMENT_TYPES;

/** EQUITY → Equity. */
export const facetValueLabel = (facet: PickerFacet, value: string) =>
  facet === "instrumentType"
    ? value.charAt(0) + value.slice(1).toLowerCase()
    : value;

/**
 * Most matches the picker lists, and so the most Add matches adds at once:
 * the whole demo universe, and a `ric in [...]` filter that stays small.
 */
export const PICKER_ROW_LIMIT = 500;

/** True when a search or a facet narrows the list (Add matches is offered). */
export const isNarrowed = (query: string, facets: PickerFacetValues) =>
  query.trim() !== "" || Object.values(facets).some((v) => v && v.length > 0);

/**
 * The picker's vuu filter over `instruments`: the text search (ric and
 * description, in the casings the grid's quick filter tries) AND each
 * facet's `in [...]`. "" when nothing narrows the list.
 */
export const pickerFilter = (query: string, facets: PickerFacetValues) => {
  const parts: string[] = [];
  for (const { column } of PICKER_FACETS) {
    const values = facets[column];
    if (values?.length) {
      parts.push(
        values.length === 1
          ? `${column} = ${filterString(values[0])}`
          : `${column} in [${values.map(filterString).join(",")}]`,
      );
    }
  }
  const search = quickFilterExpression(query);
  if (search) parts.push(parts.length ? `(${search})` : search);
  return parts.join(" and ");
};

/** "Any", "Energy", "Energy +2". */
export const facetSummary = (facet: PickerFacet, values: readonly string[]) =>
  values.length === 0
    ? "Any"
    : values.length === 1
      ? facetValueLabel(facet, values[0])
      : `${facetValueLabel(facet, values[0])} +${values.length - 1}`;

/** `picked` plus each of `rics` not already in it, in order. */
export const addRics = (picked: readonly string[], rics: readonly string[]) => {
  const have = new Set(picked);
  return [...picked, ...rics.filter((r) => !have.has(r) && have.add(r))];
};

/** Adds `ric`, or removes it if it is already picked. */
export const toggleRic = (picked: readonly string[], ric: string) =>
  picked.includes(ric) ? picked.filter((r) => r !== ric) : [...picked, ric];
