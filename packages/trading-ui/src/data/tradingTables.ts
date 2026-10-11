import {
  getTradingSchemas,
  type TradingSchemaName,
} from "@heswell/trading-schemas";
import type { TableSchema } from "@vuu-ui/vuu-data-types";
import type { VuuTable } from "@vuu-ui/vuu-protocol-types";

let schemas: Record<TradingSchemaName, TableSchema> | undefined;

/**
 * TableSchema of a trading table or join, from @heswell/trading-schemas -
 * identical to the server's TABLE_META_RESP, so no server round trip is
 * needed before creating a data source.
 */
export const tradingTableSchema = (table: TradingSchemaName): TableSchema => {
  schemas ??= getTradingSchemas();
  return schemas[table];
};

/** `{ module, table }` for a trading table, e.g. EXCHANGE:instrumentPrices. */
export const tradingVuuTable = (table: TradingSchemaName): VuuTable =>
  tradingTableSchema(table).table;

/** All column names of a trading table, in schema order. */
export const tradingColumnNames = (table: TradingSchemaName): string[] =>
  tradingTableSchema(table).columns.map(({ name }) => name);
