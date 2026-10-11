/**
 * Server adapter: builds @heswell/vuu-server TableDefs / join factories from
 * the shared definitions. Import via `@heswell/trading-schemas/server` so that
 * UI consumers of the main entry point never pull in vuu-server.
 */
import {
  Join,
  JoinSpec,
  JoinTableDef,
  Link,
  TableDef,
  VisualLinks,
} from "@heswell/vuu-server";
import {
  type JoinDefinition,
  type TableDefinition,
  joinTableColumns,
} from "../tables/tableDefinition";
import { exchangeTables, omsTables } from "../tables/tables";

/** Structural type of vuu-server TableDefContainer (not exported by vuu-server). */
export interface TableDefLookup {
  get: (module: string, tableName: string) => TableDef;
}

export type TableJoinFactory = (container: TableDefLookup) => JoinTableDef;

const toColumns = (
  def: TableDefinition | JoinDefinition,
): TableDef["columns"] =>
  ("baseTable" in def ? joinTableColumns(def) : def.columns).map(
    ({ name, dataType }) => ({ name, dataType }),
  );

/**
 * Create a new vuu-server TableDef. A TableDef is bound to a module when that
 * module is built, so create a fresh one per module instance.
 */
export const toServerTableDef = (def: TableDefinition): TableDef =>
  TableDef({
    name: def.name,
    keyField: def.keyField,
    columns: toColumns(def),
    joinFields: def.joinFields ? [...def.joinFields] : undefined,
    links: VisualLinks(
      ...(def.links ?? []).map(({ fromColumn, toTable, toColumn }) =>
        Link(fromColumn, toTable, toColumn),
      ),
    ),
  });

/** Join factory for `ModuleFactory.addJoinTable`. */
export const toServerJoinFactory =
  (def: JoinDefinition): TableJoinFactory =>
  (container) =>
    JoinTableDef({
      name: def.name,
      baseTable: container.get(def.baseTable.module, def.baseTable.name),
      joinColumns: toColumns(def),
      joins: Join(
        container.get(def.joinTable.module, def.joinTable.name),
        JoinSpec(def.left, def.right, def.type),
      ),
      joinFields: [],
      links: VisualLinks(),
    });

const toServerTableDefs = <T extends Record<string, TableDefinition>>(
  defs: T,
) =>
  Object.fromEntries(
    Object.entries(defs).map(([k, def]) => [k, toServerTableDef(def)]),
  ) as { [K in keyof T]: TableDef };

/** Fresh server TableDefs for the EXCHANGE module tables. */
export const createExchangeTableDefs = () => toServerTableDefs(exchangeTables);
/** Fresh server TableDefs for the OMS module tables. */
export const createOmsTableDefs = () => toServerTableDefs(omsTables);
