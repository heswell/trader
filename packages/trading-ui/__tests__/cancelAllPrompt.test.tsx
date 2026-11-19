import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { OrdType, Side, TimeInForce } from "@heswell/trading-schemas";
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
import type { ReactNode } from "react";
import { OrderBlotter, TradingDataProvider } from "../src";

afterEach(cleanup);

describe("Cancel all confirmation", () => {
  setCurrentUser({ name: "admin", authorizations: [] });
  const testData = createTradingTestData({
    seed: 21,
    exchange: { activeInstruments: 5 },
    oms: { flowRate: 0 },
    manualClock: true,
  });
  testData.advance(2_000);
  const localServer = createTradingLocalServer(testData, "cancel-all-test");
  const engine = testData.omsService.engine;
  afterAll(() => testData.dispose());

  let cancelAllCalls = 0;
  const original = engine.cancelAll.bind(engine);
  engine.cancelAll = (...args: Parameters<typeof engine.cancelAll>) => {
    cancelAllCalls += 1;
    return original(...args);
  };

  const Wrapper = ({ children }: { children: ReactNode }) => (
    <TradingDataProvider mode="local" localServer={localServer}>
      {children}
    </TradingDataProvider>
  );

  /** A limit buy joining the best bid, so it rests. */
  const restingBuy = (bookIndex: number) => {
    const book = testData.sim.books[bookIndex];
    const result = engine.createOrder(
      {
        account: "ACC-US-01",
        ric: book.ric,
        side: Side.Buy,
        ordType: OrdType.Limit,
        quantity: 100,
        price: book.topOfBook().bid,
        timeInForce: TimeInForce.Day,
      },
      { user: "admin" },
    );
    if (!result.ok) throw Error(`order rejected: ${result.reason}`);
    return book.ric;
  };

  const ric0 = restingBuy(0);
  restingBuy(0);
  const ric1 = restingBuy(1);
  testData.advance(200);

  const openPrompt = async () => {
    // one pane: a two-pane SplitPane stalls under happy-dom (upstream-issues 119)
    render(<OrderBlotter showChildOrders={false} />, { wrapper: Wrapper });
    const button = screen.getByRole("button", {
      name: "Cancel all",
    }) as HTMLButtonElement;
    await waitFor(() => {
      act(() => testData.advance(50));
      expect(button.disabled).toBe(false);
    });
    fireEvent.click(button);
    return waitFor(() => screen.getByRole("dialog"));
  };

  test("asks first: count, per-RIC list, nothing sent on Keep orders", async () => {
    const dialog = await openPrompt();
    expect(dialog.textContent).toContain("Cancel all orders?");
    expect(dialog.textContent).toContain("all 3 of your working orders");
    const rics = screen.getByRole("list", {
      name: "Working orders by instrument",
    });
    expect(rics.textContent).toContain(`${ric0} ×2`);
    expect(rics.textContent).toContain(ric1);
    expect(
      screen.getByRole("button", { name: "Cancel 3 orders" }),
    ).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe("Keep orders"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Keep orders" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(cancelAllCalls).toBe(0);
  });

  test("Escape closes without cancelling", async () => {
    const dialog = await openPrompt();
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(cancelAllCalls).toBe(0);
  });

  test("confirm sends cancelAll once", async () => {
    await openPrompt();
    fireEvent.click(screen.getByRole("button", { name: "Cancel 3 orders" }));
    await waitFor(() => expect(cancelAllCalls).toBe(1));
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() =>
      expect(screen.getByText("Cancel all sent for 3 order(s)")).toBeTruthy(),
    );
  });
});
