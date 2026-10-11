import type { TableDefinition } from "@heswell/trading-schemas";
import type { VuuLink } from "@vuu-ui/vuu-protocol-types";

/**
 * Visual links declared on the trading-schemas table definitions, restricted
 * to parent tables published by the same module (engine-local links are
 * module scoped, as on the Vuu server).
 */
export const visualLinksFor = <T extends string>(
  defs: Partial<Record<T, TableDefinition>>,
  moduleTables: readonly T[],
): Record<T, VuuLink[] | undefined> => {
  const names = new Set<string>(moduleTables);
  return Object.fromEntries(
    moduleTables.map((name) => {
      const links = (defs[name]?.links ?? [])
        .filter(({ toTable }) => names.has(toTable))
        .map(({ fromColumn, toTable, toColumn }) => ({
          fromColumn,
          toTable,
          toColumn,
        }));
      return [name, links.length > 0 ? links : undefined];
    }),
  ) as Record<T, VuuLink[] | undefined>;
};
