/** Quote a string literal for a vuu filter expression (`ric = ${filterString(ric)}`). */
export const filterString = (value: string) =>
  `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/**
 * Join simple vuu filter clauses (no `or`) with `and`, skipping empty ones
 * ("" if none).
 */
export const andFilters = (...clauses: readonly string[]) =>
  clauses.filter((clause) => clause.trim() !== "").join(" and ");
