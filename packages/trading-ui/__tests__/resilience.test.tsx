import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  createTradingTestData,
  setCurrentUser,
} from "@heswell/trading-test-data";
import { createTradingLocalServer } from "@heswell/trading-test-data/react";
import { OrdType, Side } from "@heswell/trading-schemas";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { DataSource } from "@vuu-ui/vuu-data-types";
import type { ReactNode } from "react";
import {
  ConnectionStatusIndicator,
  connectionStateStore,
  editOrdersInSession,
  InstrumentContextProvider,
  MarketDepth,
  OrderTicket,
  PositionsView,
  sendTradingRpc,
  type TradingConnectionState,
  TradingConnectionStateOverride,
  TradingDataProvider,
  TradingRpcError,
  type TradingOrderEvent,
} from "../src";

setCurrentUser({ name: "admin", authorizations: [] });
const td = createTradingTestData({
  seed: 11,
  exchange: { activeInstruments: 3 },
  oms: { flowRate: 0 },
  manualClock: true,
});
td.advance(2_000);
const localServer = createTradingLocalServer(td, "resilience-test");
const ric = td.sim.books[0].ric;

afterEach(() => {
  cleanup();
  connectionStateStore.reset();
});
afterAll(() => td.dispose());

const Wrapper = ({
  state,
  children,
}: {
  state?: TradingConnectionState;
  children: ReactNode;
}) => (
  <TradingDataProvider localServer={localServer} mode="local">
    <InstrumentContextProvider>
      <TradingConnectionStateOverride state={state}>
        {children}
      </TradingConnectionStateOverride>
    </InstrumentContextProvider>
  </TradingDataProvider>
);

const hangingDataSource = (calls: string[] = []) =>
  ({
    rpcRequest: () => {
      calls.push("rpcRequest");
      return new Promise(() => undefined);
    },
    beginEditSession: () => {
      calls.push("beginEditSession");
      return new Promise(() => undefined);
    },
  }) as unknown as DataSource;

describe("RPC failure handling", () => {
  test("fails fast without sending while not connected", async () => {
    const calls: string[] = [];
    const error = await sendTradingRpc(
      hangingDataSource(calls),
      "cancelOrder",
      { orderId: "ORD-1" },
      { connectionState: "reconnecting" },
    ).catch((e) => e);
    expect(error).toBeInstanceOf(TradingRpcError);
    expect(error.transport).toBe("disconnected");
    expect(error.reason).toBe("INTERNAL_ERROR");
    expect(error.text).toContain("not connected");
    expect(calls).toEqual([]);
  });

  test("times out an RPC that gets no answer", async () => {
    const error = await sendTradingRpc(
      hangingDataSource(),
      "createOrder",
      {
        account: "ACC",
        ric,
        side: Side.Buy,
        ordType: OrdType.Market,
        quantity: 100,
        clOrdId: "C1",
      } as never,
      { timeoutMs: 20 },
    ).catch((e) => e);
    expect(error).toBeInstanceOf(TradingRpcError);
    expect(error.transport).toBe("timeout");
    expect(error.text).toContain("may have been accepted");
  });

  test("times out an edit session that never begins", async () => {
    const error = await editOrdersInSession(
      hangingDataSource(),
      { cancel: ["ORD-1"] },
      { timeoutMs: 20 },
    ).catch((e) => e);
    expect(error).toBeInstanceOf(TradingRpcError);
    expect(error.transport).toBe("timeout");
  });
});

describe("ConnectionStatusIndicator", () => {
  test("shows the worst state of the observed connections, with retry", async () => {
    let retries = 0;
    render(<ConnectionStatusIndicator connectionIds={["test-a", "test-b"]} />);
    const status = screen.getByRole("status");
    // never-opened connections are disconnected
    expect(status.dataset.connectionState).toBe("disconnected");

    act(() => {
      connectionStateStore.set("test-a", {
        state: "reconnecting",
        nextAttemptAt: Date.now() + 4_500,
        retry: () => retries++,
      });
      connectionStateStore.set("test-b", { state: "reconnecting" });
    });
    expect(status.dataset.connectionState).toBe("reconnecting");
    expect(status.textContent).toMatch(/Reconnecting… retrying in [45]s/);
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
    expect(retries).toBe(1);

    act(() => {
      connectionStateStore.set("test-b", { state: "failed" });
    });
    expect(status.dataset.connectionState).toBe("failed");
    expect(status.textContent).toContain("Connection failed");
  });

  test("an explicit state, and local data counts as connected", () => {
    render(<ConnectionStatusIndicator state="reconnecting" />);
    expect(screen.getByRole("status").dataset.connectionState).toBe(
      "reconnecting",
    );
    cleanup();
    render(<ConnectionStatusIndicator connectionIds={[]} />);
    expect(screen.getByRole("status").textContent).toBe("Connected");
  });
});

describe("while disconnected", () => {
  test("the order ticket blocks submission, then re-enables", async () => {
    const events: TradingOrderEvent[] = [];
    const ticket = (state?: TradingConnectionState) => (
      <Wrapper state={state}>
        <OrderTicket
          followSelection={false}
          onOrderEvent={(e) => events.push(e)}
          prefill={{
            ric,
            account: "ACC-US-01",
            ordType: OrdType.Market,
            side: Side.Buy,
            quantity: 100,
          }}
          rememberAccount={false}
        />
      </Wrapper>
    );
    const { rerender } = render(ticket("reconnecting"));
    const form = screen.getByRole("form");
    const submit = () =>
      form.querySelector(".tradingOrderTicket-submit") as HTMLButtonElement;
    expect(form.dataset.connectionState).toBe("reconnecting");
    expect(submit().disabled).toBe(true);
    expect(form.textContent).toContain("Connection lost, reconnecting");

    act(() => {
      fireEvent.keyDown(form, { key: "F9" });
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toHaveLength(0);
    expect(form.dataset.submission).toBe("idle");

    rerender(ticket(undefined));
    await waitFor(() => expect(submit().disabled).toBe(false));
    expect(form.querySelector(".tradingOrderTicket-blocked")).toBeNull();
  });

  test("ticking views are marked stale", () => {
    const { rerender } = render(
      <Wrapper state="disconnected">
        <MarketDepth ric={ric} />
        <PositionsView />
      </Wrapper>,
    );
    const stale = () =>
      [...document.querySelectorAll("[data-stale]")].map(
        (el) => (el as HTMLElement).dataset.staleReason,
      );
    expect(stale()).toEqual(["disconnected", "disconnected"]);
    rerender(
      <Wrapper state="reconnecting">
        <MarketDepth ric={ric} />
        <PositionsView />
      </Wrapper>,
    );
    expect(stale()).toEqual(["reconnecting", "reconnecting"]);
    rerender(
      <Wrapper>
        <MarketDepth ric={ric} />
        <PositionsView />
      </Wrapper>,
    );
    expect(stale()).toEqual([]);
  });
});
