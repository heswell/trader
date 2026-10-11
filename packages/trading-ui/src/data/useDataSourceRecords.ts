import type { DataSource, DataSourceRow } from "@vuu-ui/vuu-data-types";
import type { VuuRowDataItemType } from "@vuu-ui/vuu-protocol-types";
import { metadataKeys, Range } from "@vuu-ui/vuu-utils";
import { useEffect, useRef, useState } from "react";

/** A row as a column-name keyed record, plus the row key and position. */
export type DataRecord = Record<string, VuuRowDataItemType> & {
  readonly $key: string;
  readonly $index: number;
  readonly $isLeaf: boolean;
  readonly $depth: number;
};

export interface UseDataSourceRecordsOptions {
  /** Rows to request, [from, to). Default [0, 100). Initial only. */
  range?: { from: number; to: number };
  /** Subscribe only while true (default true). */
  enabled?: boolean;
}

export interface DataSourceRecords {
  /** Rows in data source order (index 0 first) for the subscribed range. */
  records: DataRecord[];
  /** Total rows the data source holds (after filter), not just the range. */
  size: number;
}

const EMPTY: DataSourceRecords = { records: [], size: 0 };

const toRecord = (row: DataSourceRow, columns: readonly string[]) => {
  const record: Record<string, unknown> = {
    $index: row[metadataKeys.IDX],
    $key: row[metadataKeys.KEY],
    $isLeaf: row[metadataKeys.IS_LEAF],
    $depth: row[metadataKeys.DEPTH],
  };
  for (let i = 0; i < columns.length; i++) {
    record[columns[i]] = row[metadataKeys.count + i];
  }
  return record as DataRecord;
};

/**
 * Subscribe a data source you own (not one a vuu Table drives) and get its
 * rows as records. Updates are coalesced to one React render per animation
 * frame, so a burst of ticks costs one render. Re-subscribes if the data
 * source changes; the caller owns configuration (`ds.filter = ...`) and
 * `useTradingDataSource` unsubscribes on unmount.
 */
export const useDataSourceRecords = (
  dataSource: DataSource | undefined,
  { enabled = true, range }: UseDataSourceRecordsOptions = {},
): DataSourceRecords => {
  const [result, setResult] = useState<DataSourceRecords>(EMPTY);
  const from = range?.from ?? 0;
  const to = range?.to ?? 100;
  const rowsRef = useRef(new Map<number, DataRecord>());

  // biome-ignore lint/correctness/useExhaustiveDependencies: range is initial config
  useEffect(() => {
    if (!dataSource || !enabled) return;
    const rows = rowsRef.current;
    rows.clear();
    let size = 0;
    let frame: number | undefined;
    let disposed = false;

    const flush = () => {
      frame = undefined;
      if (disposed) return;
      const records: DataRecord[] = [];
      for (let i = from; i < Math.min(to, size); i++) {
        const record = rows.get(i);
        if (record) records.push(record);
      }
      setResult({ records, size });
    };
    const schedule = () => {
      if (frame === undefined) frame = requestAnimationFrame(flush);
    };

    dataSource.subscribe({ range: Range(from, to) }, (message) => {
      if (message.type === "viewport-clear") {
        rows.clear();
        schedule();
      } else if (message.type === "viewport-update") {
        if (message.size !== undefined) {
          size = message.size;
          for (const index of rows.keys()) {
            if (index >= size) rows.delete(index);
          }
        }
        if (message.rows) {
          const columns = dataSource.columns;
          for (const row of message.rows) {
            rows.set(row[metadataKeys.IDX], toRecord(row, columns));
          }
        }
        schedule();
      }
    });
    return () => {
      disposed = true;
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [dataSource, enabled]);

  return result;
};
