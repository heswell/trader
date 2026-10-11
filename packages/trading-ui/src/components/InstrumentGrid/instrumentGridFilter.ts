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
}

/** AND of the grid's filters as one vuu filter string ("" = no filter). */
export const buildInstrumentGridFilter = ({
  quickFilter = "",
  searchColumns,
  simulatedOnly,
  watchlistRics,
}: InstrumentGridFilterParts) => {
  const parts: string[] = [];
  if (simulatedOnly) parts.push("simulated = true");
  if (watchlistRics) parts.push(watchlistFilterExpression(watchlistRics));
  const search = quickFilterExpression(quickFilter, searchColumns);
  if (search)
    parts.push(
      parts.length || search.includes(" or ") ? `(${search})` : search,
    );
  return parts.join(" and ");
};
