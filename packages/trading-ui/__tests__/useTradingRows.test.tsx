import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  createTradingLocalServer,
  createTradingTestData,
  setCurrentUser,
} from "@heswell/trading-test-data";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import {
  TradingDataProvider,
  type TradingRowObject,
  useTradingRows,
} from "../src";

setCurrentUser({ name: "admin", authorizations: [] });
const testData = createTradingTestData({
  seed: 3,
  exchange: { activeInstruments: 5 },
  oms: { flowRate: 0 },
  manualClock: true,
});
testData.advance(2_000);
const localServer = createTradingLocalServer(testData, "trading-rows-test");

afterEach(cleanup);
afterAll(() => testData.dispose());

const Probe = ({
  filter,
  onRows,
}: {
  filter?: string;
  onRows: (rows: TradingRowObject[]) => void;
}) => {
  const { rows } = useTradingRows("instruments", { filter, rowCount: 500 });
  useEffect(() => onRows(rows), [rows, onRows]);
  return null;
};

describe("useTradingRows", () => {
  test("returns rows as objects and follows filter changes", async () => {
    let latest: TradingRowObject[] = [];
    const onRows = (rows: TradingRowObject[]) => {
      latest = rows;
    };
    const { rerender } = render(
      <TradingDataProvider mode="local" localServer={localServer}>
        <Probe onRows={onRows} />
      </TradingDataProvider>,
    );
    await waitFor(() => expect(latest.length).toBeGreaterThan(5));
    const first = latest[0];
    expect(first.ric).toBeString();
    expect(first.$key).toBe(first.ric as string);
    expect(first.lotSize).toBeNumber();

    const ric = first.ric as string;
    act(() =>
      rerender(
        <TradingDataProvider mode="local" localServer={localServer}>
          <Probe onRows={onRows} filter={`ric starts "${ric.slice(0, 3)}"`} />
        </TradingDataProvider>,
      ),
    );
    await waitFor(() => {
      expect(latest.length).toBeGreaterThan(0);
      expect(
        latest.every((r) => (r.ric as string).startsWith(ric.slice(0, 3))),
      ).toBe(true);
    });
  });
});
