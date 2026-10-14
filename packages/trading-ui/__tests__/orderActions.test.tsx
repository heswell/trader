import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  createTradingLocalServer,
  createTradingTestData,
  setCurrentUser,
} from "@heswell/trading-test-data";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { DataSource } from "@vuu-ui/vuu-data-types";
import { useEffect } from "react";
import {
  editOrdersInSession,
  openOrderEditSession,
  sendTradingRpc,
  StaleOrderEditError,
  TradingDataProvider,
  useDataSourceRows,
  useTradingDataSource,
  type DataSourceRows,
} from "../src";

setCurrentUser({ name: "admin", authorizations: [] });
const testData = createTradingTestData({
  seed: 11,
  exchange: { activeInstruments: 5 },
  oms: { flowRate: 0 },
  manualClock: true,
});
testData.advance(2_000);
const localServer = createTradingLocalServer(
  testData,
  "trading-ui-order-actions",
);

afterEach(cleanup);
afterAll(() => testData.dispose());

const Orders = ({
  onReady,
  onRecords,
}: {
  onReady: (ds: DataSource) => void;
  onRecords: (r: DataSourceRows) => void;
}) => {
  const ds = useTradingDataSource("parentOrders");
  const records = useDataSourceRows(ds);
  useEffect(() => {
    onReady(ds);
  }, [ds, onReady]);
  useEffect(() => onRecords(records), [records, onRecords]);
  return null;
};

const setup = async () => {
  let ds: DataSource | undefined;
  let latest: DataSourceRows = { rows: [], size: 0, loaded: false, version: 0 };
  render(
    <TradingDataProvider mode="local" localServer={localServer}>
      <Orders
        onReady={(d) => {
          ds = d;
        }}
        onRecords={(r) => {
          latest = r;
        }}
      />
    </TradingDataProvider>,
  );
  await waitFor(() => expect(ds).toBeDefined());
  // an rpc needs a subscribed viewport
  await waitFor(() => expect(latest.size).toBeGreaterThanOrEqual(0));
  return { ds: ds as DataSource, records: () => latest.rows };
};

const limitBuy = async (ds: DataSource) => {
  const ric = testData.sim.books[0].ric;
  const prices = testData.exchange.getTable("prices");
  const bid = prices.findByKey(ric)?.[prices.map.bid] as number;
  const price = Math.floor(bid * 0.95);
  return sendTradingRpc(ds, "createOrder", {
    account: "ACC-US-01",
    ric,
    side: "BUY",
    ordType: "LIMIT",
    quantity: 100,
    price,
    timeInForce: "DAY",
  } as never);
};

describe("order blotter actions", () => {
  test("amend via RPC, cancel one, then cancelAll", async () => {
    const { ds, records } = await setup();
    const a = await limitBuy(ds);
    const b = await limitBuy(ds);
    await waitFor(() => {
      expect(records().find((r) => r.orderId === a.orderId)?.status).toBe(
        "NEW",
      );
    });
    await sendTradingRpc(ds, "amendOrder", {
      orderId: a.orderId,
      quantity: 200,
    });
    await waitFor(() => {
      const r = records().find((r) => r.orderId === a.orderId);
      expect(r?.quantity).toBe(200);
    });
    await sendTradingRpc(ds, "cancelOrder", { orderId: a.orderId });
    await waitFor(() => {
      expect(records().find((r) => r.orderId === a.orderId)?.status).toBe(
        "CANCELLED",
      );
    });
    const { orderIds } = await sendTradingRpc(ds, "cancelAll", {});
    expect(orderIds).toContain(b.orderId);
    await waitFor(() => {
      expect(records().find((r) => r.orderId === b.orderId)?.status).toBe(
        "CANCELLED",
      );
    });
  });

  test("amend through the server edit session", async () => {
    const { ds, records } = await setup();
    const a = await limitBuy(ds);
    await waitFor(() =>
      expect(records().some((r) => r.orderId === a.orderId)).toBe(true),
    );
    await editOrdersInSession(ds, {
      amend: { [a.orderId]: { quantity: 300 } },
    });
    await waitFor(() => {
      const r = records().find((r) => r.orderId === a.orderId);
      expect(r?.quantity).toBe(300);
      expect(r?.version).toBe(1);
    });
  });

  test("cancel through the edit session", async () => {
    const { ds, records } = await setup();
    const a = await limitBuy(ds);
    await waitFor(() =>
      expect(records().some((r) => r.orderId === a.orderId)).toBe(true),
    );
    await editOrdersInSession(ds, { cancel: [a.orderId] });
    await waitFor(() =>
      expect(records().find((r) => r.orderId === a.orderId)?.status).toBe(
        "CANCELLED",
      ),
    );
  });

  test("a save after the order changed is refused as stale, as on the server", async () => {
    const { ds, records } = await setup();
    const a = await limitBuy(ds);
    await waitFor(() =>
      expect(records().some((r) => r.orderId === a.orderId)).toBe(true),
    );
    const session = await openOrderEditSession(ds);
    await session.amend(a.orderId, { quantity: 250 });
    await sendTradingRpc(ds, "amendOrder", {
      orderId: a.orderId,
      quantity: 400,
    });
    const error = await session.save().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(StaleOrderEditError);
    await session.discard();
    await waitFor(() =>
      expect(records().find((r) => r.orderId === a.orderId)?.quantity).toBe(
        400,
      ),
    );
  });
});
