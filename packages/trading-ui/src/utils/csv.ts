export interface CsvColumn {
  /** Key in the row records. */
  name: string;
  /** Header text, defaults to `name`. */
  label?: string;
  /** Cell text, defaults to the raw value. */
  format?: (value: unknown, row: Record<string, unknown>) => string;
}

const cell = (value: unknown) => {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/** Serialise row records to RFC 4180 CSV (CRLF line ends, quoted as needed). */
export const rowsToCsv = (
  columns: readonly CsvColumn[],
  rows: readonly Record<string, unknown>[],
) =>
  [
    columns.map(({ label, name }) => cell(label ?? name)).join(","),
    ...rows.map((row) =>
      columns
        .map(({ format, name }) =>
          cell(format ? format(row[name], row) : row[name]),
        )
        .join(","),
    ),
  ].join("\r\n");

/** Trigger a browser download of `csv`. */
export const downloadCsv = (filename: string, csv: string) => {
  const url = URL.createObjectURL(
    new Blob([csv], { type: "text/csv;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
};
