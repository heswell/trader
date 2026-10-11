import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  createTradingLocalServer,
  createTradingTestData,
  setCurrentUser,
} from "@heswell/trading-test-data";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import {
  TradingDataProvider,
  type TradingNotificationToast,
  TradingNotificationsProvider,
} from "../src";

const ADMIN = { name: "admin", authorizations: [] };
setCurrentUser(ADMIN);
const td = createTradingTestData({
  seed: 11,
  exchange: { activeInstruments: 5 },
  oms: { flowRate: 0 },
  manualClock: true,
});
td.advance(2_000);
const localServer = createTradingLocalServer(td, "notifications-test");
const ric = td.sim.books[0].ric;

afterEach(cleanup);
afterAll(() => td.dispose());

const marketBuy = (quantity: number) =>
  td.rpc(
    "createOrder",
    { account: "ACC-US-01", ric, side: "BUY", ordType: "MARKET", quantity },
    ADMIN,
  );

describe("TradingNotificationsProvider", () => {
  test("toasts fills and acks from the streams, not the snapshot", async () => {
    const lot = (() => {
      const t = td.exchange.getTable("instruments");
      return t.findByKey(ric)?.[t.map.lotSize] as number;
    })();
    // existing activity before mount must not toast
    marketBuy(lot);
    td.advance(200);

    const toasts: TradingNotificationToast[] = [];
    render(
      <TradingDataProvider localServer={localServer} mode="local">
        <TradingNotificationsProvider
          kinds={{ fill: true, filled: true, ack: true }}
          rateLimit={{ max: 100, perMs: 1000 }}
          toastSink={(t) => toasts.push(t)}
          trader="admin"
        >
          <div />
        </TradingNotificationsProvider>
      </TradingDataProvider>,
    );
    // let both subscriptions deliver their snapshot
    await new Promise((r) => setTimeout(r, 100));
    expect(toasts).toHaveLength(0);

    act(() => {
      marketBuy(lot);
      td.advance(200);
    });
    await waitFor(() => {
      const kinds = toasts.map((t) => t.event?.kind);
      expect(kinds).toContain("fill");
      expect(kinds).toContain("filled");
    });
    // one toast per execution
    const execIds = toasts
      .filter((t) => t.event?.kind === "fill")
      .map((t) => t.event?.execId);
    expect(new Set(execIds).size).toBe(execIds.length);
  });
});
