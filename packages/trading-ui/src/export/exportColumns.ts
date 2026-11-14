import type { ColumnDescriptor } from "@vuu-ui/vuu-table-types";
import { getValueFormatter } from "@vuu-ui/vuu-utils";
import type { ExportColumn, ExportDataRow } from "./csvStreams";

/**
 * Text form of a custom cell renderer: what the renderer shows, as a string.
 * Keyed by renderer name (column.type.renderer.name). The grid's renderers
 * are React components, so an export cannot run them; a renderer that
 * wants its columns exported as displayed registers one of these.
 */
export type CellTextFormatter = (
  value: unknown,
  row: ExportDataRow,
  column: ColumnDescriptor,
) => string;

export type CellTextFormatters = Readonly<Record<string, CellTextFormatter>>;

const rendererName = (column: ColumnDescriptor) => {
  const { type } = column;
  if (typeof type === "object" && type !== null) {
    const renderer = (type as { renderer?: { name?: unknown } }).renderer;
    if (renderer && typeof renderer.name === "string") return renderer.name;
  }
  return undefined;
};

/** Header text, as the grid shows it: label, else the column name. */
export const columnLabel = (column: ColumnDescriptor) =>
  column.label ?? column.name;

export type ExportColumnsOptions = {
  textFormatters?: CellTextFormatters;
  /** Server data types by column name, when the descriptors lack them. */
  serverDataTypes?: Readonly<Record<string, string>>;
};

/**
 * ExportColumns for the visible columns of a table config, formatted the way
 * the grid formats them:
 * 1. a registered CellTextFormatter for the column's renderer;
 * 2. otherwise vuu's value formatter (getValueFormatter): mapped values,
 *    numeric decimals / rounding / locale grouping, temporal patterns. This
 *    is what the default cell renderer displays. Alignment padding is
 *    trimmed.
 */
export const exportColumns = (
  columns: readonly ColumnDescriptor[],
  { textFormatters = {}, serverDataTypes = {} }: ExportColumnsOptions = {},
): ExportColumn[] =>
  columns
    .filter((column) => !column.hidden)
    .map((column) => {
      const descriptor = {
        ...column,
        serverDataType:
          column.serverDataType ??
          (serverDataTypes[column.name] as ColumnDescriptor["serverDataType"]),
      } as ColumnDescriptor;
      const renderer = rendererName(descriptor);
      const textFormatter = renderer ? textFormatters[renderer] : undefined;
      if (textFormatter) {
        return {
          name: column.name,
          label: columnLabel(column),
          format: (value, row) => textFormatter(value, row, descriptor),
        };
      }
      const valueFormatter = getValueFormatter(descriptor);
      return {
        name: column.name,
        label: columnLabel(column),
        format: (value) =>
          value === null || value === undefined
            ? ""
            : String(valueFormatter(value)).trim(),
      };
    });
