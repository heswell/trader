import type { Filter, SingleValueFilterClause } from "@vuu-ui/vuu-filter-types";

const quote = (value: string) => `"${value.replace(/["\\]/g, "")}"`;

const capitalise = (text: string) =>
  text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();

/**
 * vuu `contains` is case sensitive, rics are upper case and descriptions are
 * mixed case, so the common casings of the query are tried.
 */
const casings = (text: string) => [
  ...new Set([text, text.toUpperCase(), text.toLowerCase(), capitalise(text)]),
];

/** Quick filter: text search over ric and description. "" when there is no text. */
export const quickFilterExpression = (
  text: string,
  columns: readonly string[] = ["ric", "description"],
) => {
  const term = text.replace(/["\\]/g, "").trim();
  if (!term) return "";
  const parts: string[] = [];
  for (const column of columns) {
    for (const variant of column === "ric"
      ? [term.toUpperCase()]
      : casings(term)) {
      parts.push(`${column} contains ${quote(variant)}`);
    }
  }
  return parts.join(" or ");
};

const isContains = (
  filter: Filter,
  columns: readonly string[],
): filter is SingleValueFilterClause<string> =>
  filter.op === "contains" &&
  "column" in filter &&
  typeof filter.column === "string" &&
  columns.includes(filter.column) &&
  "value" in filter &&
  typeof filter.value === "string";

const searchVariants = (column: string, text: string) =>
  column === "ric" ? [text.toUpperCase()] : casings(text);

/**
 * The FilterBar's Search is a plain `contains`, which vuu matches case
 * sensitively: "bp" would not find BP.L. Its clause (one `contains`, or an
 * `or` of `contains` with the same text, over `searchColumns`) is widened
 * to the casings quickFilterExpression tries. Other clauses are unchanged.
 */
export const withSearchCasings = (
  filter: Filter,
  searchColumns: readonly string[],
): Filter => {
  const expand = (clause: SingleValueFilterClause<string>): Filter[] =>
    searchVariants(clause.column, clause.value).map((value) => ({
      column: clause.column,
      op: "contains",
      value,
    }));
  if (isContains(filter, searchColumns)) {
    const filters = expand(filter);
    return filters.length === 1 ? filters[0] : { op: "or", filters };
  }
  if (!("filters" in filter)) return filter;
  const isSearch =
    filter.op === "or" &&
    filter.filters.length > 0 &&
    filter.filters.every(
      (f) =>
        isContains(f, searchColumns) &&
        f.value === (filter.filters[0] as SingleValueFilterClause).value,
    );
  if (isSearch) {
    return {
      ...filter,
      filters: (filter.filters as SingleValueFilterClause<string>[]).flatMap(
        expand,
      ),
    };
  }
  if (filter.op === "and") {
    return {
      ...filter,
      filters: filter.filters.map((f) => withSearchCasings(f, searchColumns)),
    };
  }
  return filter;
};

/** Filter for a watchlist: its rics (an empty list matches nothing). */
export const watchlistFilterExpression = (rics: readonly string[]) =>
  `ric in [${(rics.length ? rics : ["-"]).map(quote).join(",")}]`;

export interface InstrumentGridFilterParts {
  quickFilter?: string;
  /** rics of the selected watchlist; undefined = all instruments. */
  watchlistRics?: readonly string[];
  /** Only instruments quoted by the exchange simulator (instrumentPrices). */
  simulatedOnly?: boolean;
  /** Columns available for the text search. */
  searchColumns?: readonly string[];
  /** Only instruments of this type (instrumentType, e.g. FUTURE). */
  instrumentType?: string;
  /** The FilterBar's filter, as a vuu filter string. */
  userFilter?: string;
}

/** AND of the grid's filters as one vuu filter string ("" = no filter). */
export const buildInstrumentGridFilter = ({
  instrumentType,
  quickFilter = "",
  searchColumns,
  simulatedOnly,
  userFilter = "",
  watchlistRics,
}: InstrumentGridFilterParts) => {
  const parts: string[] = [];
  if (simulatedOnly) parts.push("simulated = true");
  if (instrumentType) parts.push(`instrumentType = ${quote(instrumentType)}`);
  if (watchlistRics) parts.push(watchlistFilterExpression(watchlistRics));
  const search = quickFilterExpression(quickFilter, searchColumns);
  if (search)
    parts.push(
      parts.length || search.includes(" or ") ? `(${search})` : search,
    );
  const user = userFilter.trim();
  if (user) parts.push(parts.length ? `(${user})` : user);
  return parts.join(" and ");
};
