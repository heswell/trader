import type { DataSource } from "@vuu-ui/vuu-data-types";

/**
 * The parts of an engine-local data source (@heswell/vuu-data-engine-local
 * EngineDataSource / ModuleDataSource) a local export reads: the filtered,
 * sorted index of the viewport and the table's raw rows.
 */
interface LocalEngineDataSource {
  size: number;
  config?: { groupBy?: readonly unknown[] };
  engine: { rowIndexAt(position: number): number };
  dataTable: {
    engineTable: {
      rows: readonly (readonly unknown[])[];
      columnMap: Record<string, number>;
    };
  };
}

/** true for a data source served by the in-browser engine (no server). */
export const isLocalEngineDataSource = (
  dataSource: DataSource,
): dataSource is DataSource & LocalEngineDataSource => {
  const ds = dataSource as Partial<LocalEngineDataSource>;
  return (
    typeof ds.engine?.rowIndexAt === "function" &&
    ds.dataTable?.engineTable?.rows !== undefined
  );
};

export interface LocalExportRows {
  columns: string[];
  rowCount: number;
  /** Row arrays (values of `columns`), in viewport order. */
  rows: ReadableStream<unknown[]>;
}

const yieldToEventLoop = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * The local counterpart of EXPORT_VIEWPORT + the HTTP fetch: a point-in-time
 * snapshot of the viewport (sort, filter, permission and link filters
 * applied by the engine), streamed `chunkRows` rows per pull with a yield
 * between pulls so the grid keeps rendering.
 *
 * Values are copied at snapshot time: unlike vuu-server, the local tables
 * make no promise that rows are replaced rather than mutated on update.
 */
export const localExportRows = (
  dataSource: DataSource & LocalEngineDataSource,
  columns: readonly string[],
  { chunkRows = 2_000 }: { chunkRows?: number } = {},
): LocalExportRows => {
  if ((dataSource.config?.groupBy?.length ?? 0) > 0) {
    throw Error("export: grouped viewports are not supported");
  }
  const { rows: tableRows, columnMap } = dataSource.dataTable.engineTable;
  const indices = columns.map((name) => columnMap[name]);
  const missing = columns.filter((_, i) => indices[i] === undefined);
  if (missing.length > 0) {
    throw Error(`export: columns not in table: ${missing.join()}`);
  }
  // size flushes pending changes first
  const rowCount = dataSource.size;
  const snapshot: unknown[][] = [];
  for (let pos = 0; pos < rowCount; pos++) {
    const rowIdx = dataSource.engine.rowIndexAt(pos);
    if (rowIdx === -1) continue;
    const row = tableRows[rowIdx];
    snapshot.push(indices.map((i) => row[i]));
  }
  let next = 0;
  return {
    columns: [...columns],
    rowCount: snapshot.length,
    rows: new ReadableStream<unknown[]>(
      {
        async pull(controller) {
          if (next > 0) await yieldToEventLoop();
          const end = Math.min(next + chunkRows, snapshot.length);
          for (; next < end; next++) controller.enqueue(snapshot[next]);
          if (next >= snapshot.length) {
            snapshot.length = 0;
            controller.close();
          }
        },
        cancel() {
          snapshot.length = 0;
        },
      },
      { highWaterMark: 0 },
    ),
  };
};
