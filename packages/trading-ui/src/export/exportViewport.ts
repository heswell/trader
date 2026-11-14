import type { DataSource } from "@vuu-ui/vuu-data-types";
import type { VuuRowDataItemType } from "@vuu-ui/vuu-protocol-types";
import { csvFormatter, type ExportColumn, ndjsonRows } from "./csvStreams";
import { isLocalEngineDataSource, localExportRows } from "./localExport";

/** vuu-server viewport RPC (`EXPORT_VIEWPORT_RPC`). */
export const EXPORT_VIEWPORT_RPC = "EXPORT_VIEWPORT";

/** EXPORT_VIEWPORT response: a one-time ticket for the HTTP fetch. */
export interface ExportTicket {
  exportId: string;
  /** Path on the server's REST (auth) server. */
  path: string;
  /** Absolute url, when the server knows its REST url. */
  url?: string;
  columns: string[];
  rowCount: number;
  expiresAt: number;
}

/** Where the CSV goes. */
export interface ExportSink {
  writable: WritableStream<Uint8Array>;
  /** Called after the stream closes (e.g. to start a download). */
  finish?: () => void | Promise<void>;
  /** "file" (streamed to disk) or "memory" (buffered, then downloaded). */
  kind: "file" | "memory";
}

type SaveFilePicker = (options: {
  suggestedName?: string;
  types?: { description: string; accept: Record<string, string[]> }[];
}) => Promise<{ createWritable(): Promise<WritableStream<Uint8Array>> }>;

const savePicker = () =>
  (globalThis as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;

/** true if the browser can stream to a file the user picks (Chromium). */
export const canStreamToFile = () => savePicker() !== undefined;

/**
 * Buffers the file in memory, then downloads it through an object url. The
 * fallback where there is no showSaveFilePicker (Firefox, Safari): the
 * file is held in memory once, as a Blob.
 */
export const memoryDownloadSink = (fileName: string): ExportSink => {
  const chunks: Uint8Array[] = [];
  return {
    kind: "memory",
    writable: new WritableStream({
      write(chunk) {
        chunks.push(chunk);
      },
    }),
    finish() {
      const url = URL.createObjectURL(
        new Blob(chunks as BlobPart[], { type: "text/csv;charset=utf-8" }),
      );
      chunks.length = 0;
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    },
  };
};

/**
 * Ask for a file (must be called from a user gesture, before any await),
 * else fall back to an in-memory download. Rejects with an AbortError if
 * the user cancels the picker.
 */
export const pickExportSink = async (fileName: string): Promise<ExportSink> => {
  const picker = savePicker();
  if (!picker) return memoryDownloadSink(fileName);
  const handle = await picker({
    suggestedName: fileName,
    types: [{ description: "CSV file", accept: { "text/csv": [".csv"] } }],
  });
  // nb createWritable (the experiment had createWriteable). pipeTo closes it.
  return { kind: "file", writable: await handle.createWritable() };
};

/** Snapshot the data source's viewport on the server. */
export const requestViewportExport = async (
  dataSource: DataSource,
  columns: readonly string[],
): Promise<ExportTicket> => {
  if (!dataSource.rpcRequest) {
    throw Error("export: data source does not support RPC");
  }
  const result = await dataSource.rpcRequest({
    type: "RPC_REQUEST",
    rpcName: EXPORT_VIEWPORT_RPC,
    params: { columns } as unknown as Record<string, VuuRowDataItemType>,
  });
  if (result?.type === "SUCCESS_RESULT") {
    return result.data as ExportTicket;
  }
  throw Error(
    `export: ${result?.errorMessage ?? "no response from EXPORT_VIEWPORT"}`,
  );
};

export interface ExportProgress {
  rows: number;
  rowCount: number;
}

export interface ExportResult {
  rows: number;
  bytes: number;
  ms: number;
  sink: ExportSink["kind"];
}

export interface ExportViewportOptions {
  dataSource: DataSource;
  /** Output columns, in order (see exportColumns). */
  columns: readonly ExportColumn[];
  /**
   * Columns to fetch: output columns plus any sibling columns their
   * formatters read. Must be subscribed columns of the data source.
   * Default: dataSource.columns.
   */
  sourceColumns?: readonly string[];
  /** Destination. Resolve it first (pickExportSink) inside the click. */
  sink: ExportSink;
  /**
   * Base for the ticket path when the server sends no url (the auth url).
   * Not needed for a local (in-browser engine) data source.
   */
  baseUrl?: string;
  signal?: AbortSignal;
  onProgress?: (progress: ExportProgress) => void;
  fetch?: typeof fetch;
}

/**
 * Export the data source's rows, in its current sort and filter, as CSV:
 * EXPORT_VIEWPORT rpc over the websocket (snapshot on the server), then the
 * rows over HTTP, formatted client side as the grid formats them. A local
 * data source (in-browser engine) is snapshot in the browser instead.
 */
export const exportViewportToCsv = async ({
  dataSource,
  columns,
  sourceColumns = dataSource.columns,
  sink,
  baseUrl,
  signal,
  onProgress,
  fetch: fetchImpl = fetch,
}: ExportViewportOptions): Promise<ExportResult> => {
  const start = performance.now();
  let rowSource: {
    columns: () => string[];
    rowCount: number;
    rows: ReadableStream<unknown[]>;
  };
  let bytes = 0;
  try {
    rowSource = isLocalEngineDataSource(dataSource)
      ? (({ columns, rowCount, rows }) => ({
          columns: () => columns,
          rowCount,
          rows,
        }))(localExportRows(dataSource, sourceColumns))
      : await fetchServerRows(
          dataSource,
          sourceColumns,
          baseUrl,
          fetchImpl,
          signal,
        );
  } catch (error) {
    await sink.writable.abort(error).catch(() => undefined);
    throw error;
  }
  let rows = 0;
  const countBytes = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
  await rowSource.rows
    .pipeThrough(
      csvFormatter(columns, {
        sourceColumns: rowSource.columns,
        onProgress: (n) => {
          rows = n;
          onProgress?.({ rows: n, rowCount: rowSource.rowCount });
        },
      }),
    )
    .pipeThrough(new TextEncoderStream())
    .pipeThrough(countBytes)
    .pipeTo(sink.writable, { signal });
  await sink.finish?.();
  return { rows, bytes, ms: performance.now() - start, sink: sink.kind };
};

/** EXPORT_VIEWPORT, then the NDJSON body parsed into row arrays. */
const fetchServerRows = async (
  dataSource: DataSource,
  sourceColumns: readonly string[],
  baseUrl: string | undefined,
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined,
) => {
  const ticket = await requestViewportExport(dataSource, sourceColumns);
  if (!ticket.url && !baseUrl) {
    throw Error("export: the server sent no url and there is no baseUrl");
  }
  const response = await fetchImpl(
    ticket.url ?? new URL(ticket.path, baseUrl),
    {
      signal,
    },
  );
  if (!response.ok || !response.body) {
    throw Error(`export: HTTP ${response.status}`);
  }
  let serverColumns: string[] = [];
  return {
    columns: () => serverColumns,
    rowCount: ticket.rowCount,
    rows: response.body.pipeThrough(new TextDecoderStream()).pipeThrough(
      ndjsonRows((names) => {
        serverColumns = names;
      }),
    ),
  };
};
