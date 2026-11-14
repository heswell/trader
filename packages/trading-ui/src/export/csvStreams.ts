/**
 * Streams for a viewport export. Generic (no trading or React dependencies)
 * so they can move to @vuu-ui/vuu-table-extras unchanged.
 *
 * The server body is NDJSON: the first line is a JSON array of column names,
 * then one JSON array of raw values per row, in viewport order.
 *
 *   response.body
 *     .pipeThrough(new TextDecoderStream())
 *     .pipeThrough(ndjsonRows())               // string -> unknown[]
 *     .pipeThrough(csvFormatter(exportColumns)) // unknown[] -> CSV text
 *     .pipeThrough(new TextEncoderStream())
 *     .pipeTo(writable)
 */

export type ExportDataRow = Record<string, unknown>;

/** A column of the output file. */
export interface ExportColumn {
  /** Source column (in the server rows). */
  name: string;
  /** Header text. */
  label: string;
  /**
   * Text for a cell. `row` holds every source column of the row by name,
   * for formatters that read sibling columns (e.g. a price formatted by the
   * row's instrument). It is reused between rows: copy, don't keep.
   */
  format: (value: unknown, row: ExportDataRow) => string;
}

/**
 * Splits text into lines and parses each as JSON. Emits the header (column
 * names) through `onHeader`, then each row array.
 */
export const ndjsonRows = (
  onHeader?: (columns: string[]) => void,
): TransformStream<string, unknown[]> => {
  let buffer = "";
  let header = true;
  const emit = (
    line: string,
    controller: TransformStreamDefaultController<unknown[]>,
  ) => {
    if (line === "") return;
    const value = JSON.parse(line) as unknown[];
    if (header) {
      header = false;
      onHeader?.(value as string[]);
    } else {
      controller.enqueue(value);
    }
  };
  return new TransformStream({
    transform(chunk, controller) {
      buffer += chunk;
      let start = 0;
      let nl = buffer.indexOf("\n", start);
      while (nl !== -1) {
        emit(buffer.slice(start, nl), controller);
        start = nl + 1;
        nl = buffer.indexOf("\n", start);
      }
      buffer = buffer.slice(start);
    },
    flush(controller) {
      emit(buffer, controller);
    },
  });
};

const NEEDS_QUOTES = /[",\r\n]|^\s|\s$/;
/** RFC 4180 field. */
export const csvField = (text: string) =>
  NEEDS_QUOTES.test(text) ? `"${text.replaceAll('"', '""')}"` : text;

export type CsvFormatterOptions = {
  /** Source column names, in server row order. Default: from ndjsonRows. */
  sourceColumns?: () => string[];
  /** Line ending. Default "\r\n" (RFC 4180, what Excel writes). */
  eol?: string;
  /** Start with a UTF-8 BOM so Excel detects the encoding. Default true. */
  bom?: boolean;
  /** Rows per emitted chunk. Default 500. */
  batchRows?: number;
  onProgress?: (rows: number) => void;
};

/**
 * Formats raw row arrays as CSV text, a header line first, each value
 * through its ExportColumn's formatter.
 */
export const csvFormatter = (
  columns: readonly ExportColumn[],
  {
    sourceColumns,
    eol = "\r\n",
    bom = true,
    batchRows = 500,
    onProgress,
  }: CsvFormatterOptions = {},
): TransformStream<unknown[], string> => {
  let names: string[] | undefined;
  let index: Int32Array;
  const row: ExportDataRow = {};
  let rows = 0;
  let text = "";
  let pending = 0;
  const init = () => {
    names = sourceColumns?.() ?? columns.map((c) => c.name);
    index = Int32Array.from(columns, (c) => names?.indexOf(c.name) ?? -1);
    const missing = columns.filter((_, i) => index[i] === -1);
    if (missing.length > 0) {
      throw Error(
        `export: columns not in data: ${missing.map((c) => c.name).join()}`,
      );
    }
  };
  return new TransformStream({
    start(controller) {
      controller.enqueue(
        (bom ? "﻿" : "") + columns.map((c) => csvField(c.label)).join(",") + eol,
      );
    },
    transform(values, controller) {
      if (names === undefined) init();
      const sourceNames = names as string[];
      for (let i = 0; i < sourceNames.length; i++) {
        row[sourceNames[i]] = values[i];
      }
      let line = "";
      for (let i = 0; i < columns.length; i++) {
        if (i > 0) line += ",";
        line += csvField(columns[i].format(values[index[i]], row));
      }
      text += line + eol;
      rows += 1;
      if (++pending >= batchRows) {
        controller.enqueue(text);
        text = "";
        pending = 0;
        onProgress?.(rows);
      }
    },
    flush(controller) {
      if (text) controller.enqueue(text);
      onProgress?.(rows);
    },
  });
};
