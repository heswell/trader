import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  createTradingTestData,
  setCurrentUser,
} from "@heswell/trading-test-data";
import { createTradingLocalServer } from "@heswell/trading-test-data/react";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { DataSource, DataSourceRow } from "@vuu-ui/vuu-data-types";
import { Range } from "@vuu-ui/vuu-utils";
import { useEffect } from "react";
import { TradingDataProvider, useChartDataSource } from "../src";
import { disableSeriesAnimation } from "../src/components/ChartFrame/ChartFrame";

setCurrentUser({ name: "admin", authorizations: [] });
const testData = createTradingTestData({
  seed: 11,
  exchange: { activeInstruments: 3 },
  oms: { flowRate: 0 },
  manualClock: true,
});
testData.advance(2_000);
const localServer = createTradingLocalServer(testData, "chart-ds-test");
const [RIC, OTHER] = testData.sim.books.map((book) => book.ric);

afterEach(cleanup);
afterAll(() => testData.dispose());

const COLUMNS = ["id", "ric", "interval", "start", "close"];

const Probe = ({
  ric,
  disabled,
  onDataSource,
  onRows,
}: {
  ric: string;
  disabled?: boolean;
  onDataSource: (ds: DataSource | undefined) => void;
  onRows?: (rows: DataSourceRow[]) => void;
}) => {
  const ds = useChartDataSource("bars", {
    columns: COLUMNS,
    disabled,
    filter: `ric = "${ric}" and interval = "1m"`,
    sort: { column: "start" },
  });
  useEffect(() => {
    onDataSource(ds);
    if (!ds || !onRows) return;
    ds.subscribe({ range: Range(0, 20) }, (message) => {
      if (message.type === "viewport-update" && message.rows) {
        onRows(message.rows);
      }
    });
    return () => ds.unsubscribe();
  }, [ds, onDataSource, onRows]);
  return null;
};

const wrap = (children: React.ReactNode) => (
  <TradingDataProvider mode="local" localServer={localServer}>
    {children}
  </TradingDataProvider>
);

describe("useChartDataSource", () => {
  test("filters and sorts server-side (one ric and interval, newest first)", async () => {
    const rows = new Map<number, DataSourceRow>();
    render(
      wrap(
        <Probe
          ric={RIC}
          onDataSource={() => undefined}
          onRows={(update) => {
            for (const row of update) rows.set(row[0], row);
          }}
        />,
      ),
    );
    await waitFor(() => expect(rows.size).toBeGreaterThan(5));
    // data columns follow the 10 vuu metadata columns, in COLUMNS order
    const byIndex = [...rows.values()].sort((a, b) => a[0] - b[0]);
    const ric = 10 + COLUMNS.indexOf("ric");
    const interval = 10 + COLUMNS.indexOf("interval");
    const start = 10 + COLUMNS.indexOf("start");
    for (const row of byIndex) {
      expect(row[ric]).toBe(RIC);
      expect(row[interval]).toBe("1m");
    }
    const starts = byIndex.map((row) => row[start] as number);
    expect(starts).toEqual([...starts].sort((a, b) => b - a));
  });

  test("a new DataSource per filter; none while disabled", () => {
    const seen: (DataSource | undefined)[] = [];
    const onDataSource = (ds: DataSource | undefined) => seen.push(ds);
    const { rerender } = render(
      wrap(<Probe ric={RIC} onDataSource={onDataSource} />),
    );
    rerender(wrap(<Probe ric={RIC} onDataSource={onDataSource} />));
    expect(seen).toHaveLength(1);
    rerender(wrap(<Probe ric={OTHER} onDataSource={onDataSource} />));
    expect(seen).toHaveLength(2);
    expect(seen[1]).not.toBe(seen[0]);
    rerender(wrap(<Probe ric={OTHER} disabled onDataSource={onDataSource} />));
    expect(seen.at(-1)).toBeUndefined();
  });
});

describe("disableSeriesAnimation", () => {
  test("turns animation off on every series and keeps the rest", () => {
    const option = {
      animation: false,
      series: [
        { id: "a", type: "treemap" },
        { type: "line", data: [1] },
      ],
    };
    expect(disableSeriesAnimation(option)).toEqual({
      animation: false,
      series: [
        { id: "a", type: "treemap", animation: false },
        { type: "line", data: [1], animation: false },
      ],
    });
    const noSeries = { animation: false };
    expect(disableSeriesAnimation(noSeries)).toBe(noSeries);
  });
});
