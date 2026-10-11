import type { TableSchema } from "@vuu-ui/vuu-data-types";
import {
  type JoinDefinition,
  type TableDefinition,
  joinTableColumns,
} from "./tableDefinition";
import { tradingJoins, tradingTables } from "./tables";

/**
 * vuu-ui TableSchema for a table definition - the same shape the Vuu server
 * returns in TABLE_META_RESP, used by local (vuu-data-test style) data sources
 * and by components that need a schema before subscribing.
 */
export const toTableSchema = (
  def: TableDefinition | JoinDefinition,
): TableSchema => {
  const isJoin = "baseTable" in def;
  const columns = isJoin ? joinTableColumns(def) : def.columns;
  return {
    columns: columns.map(({ name, dataType }) => ({
      name,
      serverDataType: dataType,
    })),
    key: isJoin ? def.baseTable.keyField : def.keyField,
    table: { module: def.module, table: def.name },
  };
};

export type TradingSchemaName =
  | keyof typeof tradingTables
  | keyof typeof tradingJoins;

/** TableSchemas for every trading table and join, keyed by table name. */
export const getTradingSchemas = (): Record<TradingSchemaName, TableSchema> =>
  Object.fromEntries(
    [...Object.values(tradingTables), ...Object.values(tradingJoins)].map(
      (def) => [def.name, toTableSchema(def)],
    ),
  ) as Record<TradingSchemaName, TableSchema>;
