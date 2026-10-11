import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { OrdStatus, Side } from "@heswell/trading-schemas";
import {
  createTradingLocalServer,
  createTradingTestData,
  setCurrentUser,
} from "@heswell/trading-test-data";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { DataSource, DataSourceRow } from "@vuu-ui/vuu-data-types";
import { Range } from "@vuu-ui/vuu-utils";
import { useEffect } from "react";
import {
  sendTradingRpc,
  TradingDataProvider,
  TradingRpcError,
  useTradingDataMode,
  useTradingDataSource,
} from "../src";

setCurrentUser({ name: "admin", authorizations: [] });
const testData = createTradingTestData({
  seed: 7,
  exchange: { activeInstruments: 5 },
  oms: { flowRate: 0 },
  manualClock: true,
});
// let the quoting bots build the order books
testData.advance(2_000);
const localServer = createTradingLocalServer(testData, "trading-ui-test");

afterEach(cleanup);
afterAll(() => testData.dispose());

/** Subscribes the hook's data source and reports the rows it receives. */
const Probe = ({
  table,
  onRows,
  onDataSource,
}: {
  table: "instrumentPrices" | "parentOrders";
  onRows: (rows: DataSourceRow[], ds: DataSource) => void;
  onDataSource?: (ds: DataSource) => void;
}) => {
  const ds = useTradingDataSource(table);
  const { mode } = useTradingDataMode();
  useEffect(() => {
    onDataSource?.(ds);
    ds.subscribe({ range: Range(0, 100) }, (message) => {
      if (message.type === "viewport-update" && message.rows) {
        onRows(message.rows, ds);
      }
    });
  }, [ds, onRows, onDataSource]);
  return <span data-mode={mode} />;
};

describe("useTradingDataSource (local mode)", () => {
  test("streams instrumentPrices from trading-test-data", async () => {
    const rows: DataSourceRow[] = [];
    const { container } = render(
      <TradingDataProvider mode="local" localServer={localServer}>
        <Probe table="instrumentPrices" onRows={(r) => rows.push(...r)} />
      </TradingDataProvider>,
    );
    expect(container.querySelector("span")?.dataset.mode).toBe("local");
    await waitFor(() => expect(rows.length).toBeGreaterThan(0));
  });

  test("sendTradingRpc creates an order and rejects with a typed error", async () => {
    let dataSource: DataSource | undefined;
    const orders = new Map<string, DataSourceRow>();
    render(
      <TradingDataProvider mode="local" localServer={localServer}>
        <Probe
          table="parentOrders"
          onDataSource={(ds) => {
            dataSource = ds;
          }}
          onRows={(rows) => {
            for (const row of rows) orders.set(row[6], row);
          }}
        />
      </TradingDataProvider>,
    );
    await waitFor(() => expect(dataSource).toBeDefined());
    const ds = dataSource as DataSource;
    const ric = testData.sim.books[0].ric;
    const { orderId } = await sendTradingRpc(ds, "createOrder", {
      account: "ACC-US-01",
      ric,
      side: Side.Buy,
      ordType: "MARKET",
      quantity: 100,
      timeInForce: "DAY",
    });
    expect(orderId).toBeString();
    const columnMap = (ds as unknown as { columnMap: Record<string, number> })
      .columnMap;
    await waitFor(() => {
      const row = [...orders.values()].find(
        (r) => r[columnMap.orderId] === orderId,
      );
      expect(row?.[columnMap.status]).toBe(OrdStatus.Filled);
    });

    const error = await sendTradingRpc(ds, "cancelOrder", {
      orderId: "NO-SUCH-ORDER",
    }).catch((e) => e);
    expect(error).toBeInstanceOf(TradingRpcError);
    expect((error as TradingRpcError).reason).toBe("UNKNOWN_ORDER");
  });
});
