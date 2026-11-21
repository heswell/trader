import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import * as webStreams from "node:stream/web";
import {
  createTradingTestData,
  setCurrentUser,
} from "@heswell/trading-test-data";
import { createTradingLocalServer } from "@heswell/trading-test-data/react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { TableConfig } from "@vuu-ui/vuu-table-types";
import {
  ExportCsvButton,
  exportStatusText,
  TradingDataProvider,
  useTradingDataSource,
} from "../src";

setCurrentUser({ name: "admin", authorizations: [] });
const testData = createTradingTestData({
  seed: 3,
  exchange: { activeInstruments: 3 },
  oms: { flowRate: 0 },
  manualClock: true,
});
const localServer = createTradingLocalServer(testData, "export-csv-button");

// happy-dom (test:ui preload) replaces the global stream classes with ones
// that do not interoperate with Bun's TextEncoderStream.
const STREAMS = [
  "ReadableStream",
  "WritableStream",
  "TransformStream",
  "TextDecoderStream",
  "TextEncoderStream",
] as const;
const globals = globalThis as unknown as Record<string, unknown>;
const saved = Object.fromEntries(
  [...STREAMS, "showSaveFilePicker"].map((name) => [name, globals[name]]),
);

/** The file the save dialog "picked": everything written to it. */
let written: Uint8Array[] = [];
let pickedName: string | undefined;

beforeAll(() => {
  for (const name of STREAMS) globals[name] = webStreams[name];
  globals.showSaveFilePicker = async ({
    suggestedName,
  }: {
    suggestedName?: string;
  }) => {
    pickedName = suggestedName;
    return {
      createWritable: async () =>
        new webStreams.WritableStream<Uint8Array>({
          write: (chunk) => void written.push(chunk),
        }),
    };
  };
});
afterEach(() => {
  cleanup();
  written = [];
  pickedName = undefined;
});
afterAll(() => {
  for (const [name, value] of Object.entries(saved)) globals[name] = value;
  testData.dispose();
});

const csv = () =>
  new TextDecoder("utf-8", { ignoreBOM: true }).decode(Buffer.concat(written));

const tableConfig: TableConfig = {
  columns: [
    { name: "ric", label: "RIC" },
    { name: "currency", label: "Ccy" },
    {
      name: "refPrice",
      label: "Ref",
      type: { name: "number", formatting: { decimals: 2 } },
    },
    { name: "exchange", hidden: true },
  ],
};

const Harness = ({ grouped = false }: { grouped?: boolean }) => {
  const dataSource = useTradingDataSource("instruments", {
    columns: ["ric", "currency", "refPrice", "exchange"],
    filterSpec: { filter: 'currency = "GBX"' },
    sort: { sortDefs: [{ column: "ric", sortType: "D" }] },
    groupBy: grouped ? ["currency"] : [],
  });
  return (
    <ExportCsvButton
      dataSource={dataSource}
      fileName="instruments.csv"
      table="instruments"
      tableConfig={tableConfig}
    />
  );
};

const exportAndWait = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /Export CSV/ }));
  });
  await waitFor(
    () =>
      expect(screen.getByTestId("export-csv-status").textContent).toMatch(
        /rows in/,
      ),
    { timeout: 5_000 },
  );
};

/** Fields of one RFC 4180 line (quoted fields may hold commas). */
const csvFields = (line: string) =>
  [...line.matchAll(/("(?:[^"]|"")*"|[^,]*)(?:,|$)/g)]
    .map((m) => m[1].replace(/^"|"$/g, "").replaceAll('""', '"'))
    .slice(0, -1);

const expectInstrumentsCsv = () => {
  const lines = csv().split("\r\n").filter(Boolean);
  expect(lines[0]).toBe("﻿RIC,Ccy,Ref");
  const rows = lines.slice(1).map(csvFields);
  expect(rows.length).toBeGreaterThan(1);
  // the data source's filter and sort, the table's visible columns
  expect(rows.every((r) => r.length === 3 && r[1] === "GBX")).toBe(true);
  const rics = rows.map((r) => r[0]);
  expect(rics).toEqual([...rics].sort().reverse());
  // vuu's number format (decimals: 2): grouped, trailing zeros dropped
  expect(rows.every((r) => /^\d{1,3}(,\d{3})*(\.\d{1,2})?$/.test(r[2]))).toBe(
    true,
  );
};

describe("ExportCsvButton", () => {
  test("exports every row in the data source's filter and sort, as the table formats them", async () => {
    render(
      <TradingDataProvider mode="local" localServer={localServer}>
        <Harness />
      </TradingDataProvider>,
    );
    await exportAndWait();
    expect(pickedName).toBe("instruments.csv");
    expectInstrumentsCsv();
  });

  test("a grouped data source exports its leaf rows", async () => {
    render(
      <TradingDataProvider mode="local" localServer={localServer}>
        <Harness grouped />
      </TradingDataProvider>,
    );
    await exportAndWait();
    expectInstrumentsCsv();
  });

  test("status text", () => {
    expect(exportStatusText({ state: "idle" }).text).toBe("");
    expect(
      exportStatusText({ state: "running", rows: 250, rowCount: 1_000 }),
    ).toEqual({ text: "25%", title: "250 of 1,000 rows" });
    const done = exportStatusText({
      state: "done",
      result: {
        rows: 1_000_000,
        bytes: 53_400_000,
        ms: 11_200,
        snapshotMs: 55,
        firstRowsMs: 70,
        sink: "file",
      },
    });
    expect(done.text).toBe("1,000,000 rows in 11.2s");
    expect(done.title).toContain("53.4 MB");
    expect(done.title).toContain("snapshot 55 ms");
    expect(
      exportStatusText({ state: "error", message: "export: HTTP 404" }),
    ).toEqual({ text: "Export failed", title: "export: HTTP 404" });
  });
});
