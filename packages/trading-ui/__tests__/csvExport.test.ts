import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as webStreams from "node:stream/web";
import type { ColumnDescriptor } from "@vuu-ui/vuu-table-types";
import type { DataSource } from "@vuu-ui/vuu-data-types";
import {
  csvField,
  csvFormatter,
  exportColumns,
  exportViewportToCsv,
  isLocalEngineDataSource,
  ndjsonRows,
  tradingTextFormatters,
} from "../src/export";
import { TradingRenderer } from "../src/components/TradingCellRenderers/rendererNames";

const streamOf = (chunks: string[]) =>
  new ReadableStream<string>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });

const collect = async <T>(stream: ReadableStream<T>) => {
  const out: T[] = [];
  for await (const chunk of stream as unknown as AsyncIterable<T>)
    out.push(chunk);
  return out;
};

const renderer = (name: string) => ({
  name: "string" as const,
  renderer: { name },
});

const columns: ColumnDescriptor[] = [
  { name: "timestamp", label: "Time", type: renderer(TradingRenderer.Time) },
  { name: "ric", label: "RIC" },
  { name: "price", label: "Price", type: renderer(TradingRenderer.Price) },
  {
    name: "size",
    label: "Size",
    serverDataType: "long",
    type: { name: "number", formatting: { useLocaleString: true } },
  },
  {
    name: "aggressorSide",
    label: "Side",
    type: renderer(TradingRenderer.Side),
  },
  { name: "seq", hidden: true },
];

const lookup = new Map([["VOD.L", { ric: "VOD.L", priceDecimals: 3 }]]);

// happy-dom (test:ui preload) replaces the global stream classes with ones
// that do not interoperate with Bun's Response.body / TextDecoderStream.
const STREAMS = [
  "ReadableStream",
  "WritableStream",
  "TransformStream",
  "TextDecoderStream",
  "TextEncoderStream",
] as const;
const globals = globalThis as unknown as Record<string, unknown>;
const saved = Object.fromEntries(STREAMS.map((name) => [name, globals[name]]));
beforeAll(() => {
  for (const name of STREAMS) globals[name] = webStreams[name];
});
afterAll(() => {
  for (const name of STREAMS) globals[name] = saved[name];
});

describe("csv export streams", () => {
  test("ndjsonRows splits lines across chunk boundaries", async () => {
    let header: string[] = [];
    const rows = await collect(
      streamOf(['["a","b"]\n[1,"x"]\n[2,', '"y,z"]\n[3', ',"w"]']).pipeThrough(
        ndjsonRows((names) => {
          header = names;
        }),
      ),
    );
    expect(header).toEqual(["a", "b"]);
    expect(rows).toEqual([
      [1, "x"],
      [2, "y,z"],
      [3, "w"],
    ]);
  });

  test("csvField quotes as RFC 4180 needs", () => {
    expect(csvField("plain")).toBe("plain");
    expect(csvField("1,234.50")).toBe('"1,234.50"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField("a\nb")).toBe('"a\nb"');
  });

  test("formats values the way the grid shows them, from sibling columns", async () => {
    const ts = new Date(2026, 10, 13, 9, 5, 7, 42).getTime();
    const out = await collect(
      new ReadableStream<unknown[]>({
        start(controller) {
          controller.enqueue([ts, "VOD.L", 1234.5, 1500, "BUY", 7]);
          controller.enqueue([ts, "XYZ.L", 0, 25, "SELL", 8]);
          controller.close();
        },
      }).pipeThrough(
        csvFormatter(
          exportColumns(columns, {
            textFormatters: tradingTextFormatters(lookup as never),
          }),
          {
            bom: false,
            sourceColumns: () => [
              "timestamp",
              "ric",
              "price",
              "size",
              "aggressorSide",
              "seq",
            ],
          },
        ),
      ),
    );
    expect(out.join("")).toBe(
      [
        "Time,RIC,Price,Size,Side",
        '09:05:07.042,VOD.L,"1,234.500","1,500",Buy',
        "09:05:07.042,XYZ.L,,25,Sell",
        "",
      ].join("\r\n"),
    );
  });

  test("exportViewportToCsv: rpc, fetch, format, write", async () => {
    const calls: unknown[] = [];
    const dataSource = {
      columns: ["ric", "price"],
      rpcRequest: async (request: unknown) => {
        calls.push(request);
        return {
          type: "SUCCESS_RESULT",
          data: {
            exportId: "x",
            path: "/api/export/x",
            columns: ["ric", "price"],
            rowCount: 2,
            expiresAt: 0,
          },
        };
      },
    } as unknown as DataSource;
    const fetched: string[] = [];
    const written: Uint8Array[] = [];
    const result = await exportViewportToCsv({
      dataSource,
      columns: exportColumns(
        [
          { name: "ric", label: "RIC" },
          { name: "price", type: renderer(TradingRenderer.Price) },
        ],
        { textFormatters: tradingTextFormatters(lookup as never) },
      ),
      baseUrl: "http://localhost:8447/api/authn",
      sink: {
        kind: "file",
        writable: new WritableStream({ write: (c) => void written.push(c) }),
      },
      fetch: (async (url: URL) => {
        fetched.push(String(url));
        return new Response('["ric","price"]\n["VOD.L",1.5]\n["VOD.L",2]\n');
      }) as unknown as typeof fetch,
    });
    expect(calls).toEqual([
      {
        type: "RPC_REQUEST",
        rpcName: "EXPORT_VIEWPORT",
        params: { columns: ["ric", "price"] },
      },
    ]);
    expect(fetched).toEqual(["http://localhost:8447/api/export/x"]);
    expect(result.rows).toBe(2);
    expect(
      new TextDecoder("utf-8", { ignoreBOM: true }).decode(
        Buffer.concat(written),
      ),
    ).toBe("﻿RIC,price\r\nVOD.L,1.500\r\nVOD.L,2.000\r\n");
  });

  test("exportViewportToCsv: local engine data source, no rpc or fetch", async () => {
    // the shape of an engine-local EngineDataSource: the viewport index
    // (sorted, filtered) over the table's raw rows
    const tableRows = [
      ["k1", "VOD.L", 1.5],
      ["k2", "BARC.L", 9],
      ["k3", "VOD.L", 2],
    ];
    const dataSource = {
      columns: ["ric", "price"],
      size: 2,
      config: { groupBy: [] },
      engine: { rowIndexAt: (pos: number) => [2, 0][pos] ?? -1 },
      dataTable: {
        engineTable: {
          rows: tableRows,
          columnMap: { key: 0, ric: 1, price: 2 },
        },
      },
      rpcRequest: () => {
        throw Error("no rpc for a local export");
      },
    } as unknown as DataSource;
    expect(isLocalEngineDataSource(dataSource)).toBe(true);
    const written: Uint8Array[] = [];
    const progress: unknown[] = [];
    const result = await exportViewportToCsv({
      dataSource,
      columns: exportColumns(
        [
          { name: "ric", label: "RIC" },
          { name: "price", type: renderer(TradingRenderer.Price) },
        ],
        { textFormatters: tradingTextFormatters(lookup as never) },
      ),
      sink: {
        kind: "file",
        writable: new WritableStream({ write: (c) => void written.push(c) }),
      },
      onProgress: (p) => void progress.push(p),
      fetch: (() => {
        throw Error("no fetch for a local export");
      }) as unknown as typeof fetch,
    });
    // a snapshot: later changes to the table don't reach the file
    tableRows[2][2] = 99;
    expect(result.rows).toBe(2);
    expect(progress.at(-1)).toEqual({ rows: 2, rowCount: 2 });
    expect(
      new TextDecoder("utf-8", { ignoreBOM: true }).decode(
        Buffer.concat(written),
      ),
    ).toBe("\uFEFFRIC,price\r\nVOD.L,2.000\r\nVOD.L,1.500\r\n");
  });

  test("a remote data source is not a local engine one", () => {
    expect(
      isLocalEngineDataSource({ columns: [] } as unknown as DataSource),
    ).toBe(false);
  });
});
