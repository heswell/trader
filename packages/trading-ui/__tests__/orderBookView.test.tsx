import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  AlgoStrategy,
  isWorkingStatus,
  OrdType,
  Side,
  TimeInForce,
} from "@heswell/trading-schemas";
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
import {
  OrderBlotter,
  OrderBookView,
  orderTypeLabel,
  restsAtLimit,
  TradingDataProvider,
} from "../src";

afterEach(cleanup);

describe("stop orders in the order book", () => {
  const fmt = (p: number) => p.toFixed(2);
  test("labels: Lmt, Stp, Stp + Lmt, else the type", () => {
    expect(orderTypeLabel({ ordType: OrdType.Limit, price: 99.4 }, fmt)).toBe(
      "Lmt 99.40",
    );
    expect(
      orderTypeLabel({ ordType: OrdType.Stop, stopPrice: 99.5 }, fmt),
    ).toBe("Stp 99.50");
    expect(
      orderTypeLabel(
        { ordType: OrdType.StopLimit, stopPrice: 99.5, price: 99.4 },
        fmt,
      ),
    ).toBe("Stp 99.50 Lmt 99.40");
    expect(orderTypeLabel({ ordType: OrdType.Market }, fmt)).toBe("MARKET");
  });

  test("a STOP_LIMIT rests at its limit only once triggered", () => {
    expect(restsAtLimit({ ordType: OrdType.Limit, triggeredAt: 0 })).toBe(true);
    expect(restsAtLimit({ ordType: OrdType.StopLimit, triggeredAt: 0 })).toBe(
      false,
    );
    expect(
      restsAtLimit({ ordType: OrdType.StopLimit, triggeredAt: 1_700_000 }),
    ).toBe(true);
    expect(
      restsAtLimit({ ordType: OrdType.Stop, triggeredAt: 1_700_000 }),
    ).toBe(false);
    expect(restsAtLimit({ ordType: OrdType.Market })).toBe(false);
  });
});

describe("OrderBookView (local data)", () => {
  setCurrentUser({ name: "admin", authorizations: [] });
  const testData = createTradingTestData({
    seed: 21,
    exchange: { activeInstruments: 5 },
    oms: { flowRate: 0 },
    manualClock: true,
  });
  testData.advance(2_000);
  const localServer = createTradingLocalServer(testData, "order-book-test");
  const book = testData.sim.books[0];
  afterAll(() => testData.dispose());

  const Wrapper = ({ children }: { children: ReactNode }) => (
    <TradingDataProvider mode="local" localServer={localServer}>
      {children}
    </TradingDataProvider>
  );
  const tick = () => act(() => testData.advance(100));

  /** A limit buy joining the back of the best bid's queue. */
  const restingBuy = () => {
    const price = book.topOfBook().bid;
    const result = testData.omsService.engine.createOrder(
      {
        account: "ACC-US-01",
        ric: book.ric,
        side: Side.Buy,
        ordType: OrdType.Limit,
        quantity: 300,
        price,
        timeInForce: TimeInForce.Day,
      },
      { user: "admin" },
    );
    if (!result.ok) throw Error(`order rejected: ${result.reason}`);
    return { orderId: result.value.orderId, price };
  };

  test("shows the order's level in L2 and its place in the L3 queue", async () => {
    const { orderId } = restingBuy();
    const view = render(<OrderBookView orderId={orderId} />, {
      wrapper: Wrapper,
    });
    await waitFor(() => {
      tick();
      expect(view.container.querySelector("tr[data-own]")).toBeTruthy();
    });
    const path = screen.getByRole("navigation", { name: "Drill path" });
    expect(path.textContent).toContain(orderId);
    expect(path.textContent).toMatch(/L3 · #\d+ of \d+/);

    // L2: the level holding the order is marked and selected
    const own = view.container.querySelector<HTMLElement>(
      ".tradingOrderBookView-level[data-own]",
    );
    expect(own?.getAttribute("aria-pressed")).toBe("true");
    expect(own?.getAttribute("aria-label")).toMatch(/includes this order/);

    // L3: the order is last in the queue (it joined the back) and labelled
    const rows = [
      ...view.container.querySelectorAll(
        ".tradingOrderBookView-queueTable tbody tr",
      ),
    ];
    expect(rows.at(-1)?.hasAttribute("data-own")).toBe(true);
    expect(rows.at(-1)?.textContent).toMatch(/Yours · /);
    const position = screen.getByText("Position").nextElementSibling;
    expect(position?.textContent).toBe(`#${rows.length} of ${rows.length}`);

    // the resting child order chip shows the same position
    const chip = screen.getByRole("button", { pressed: true, name: /ahead/ });
    expect(chip.textContent).toContain(`#${rows.length} of ${rows.length}`);
  });

  test("clicking another level shows its queue", async () => {
    const { orderId } = restingBuy();
    const view = render(<OrderBookView orderId={orderId} />, {
      wrapper: Wrapper,
    });
    await waitFor(() => {
      tick();
      expect(view.container.querySelector("tr[data-own]")).toBeTruthy();
    });
    const ask = screen.getAllByRole("button", {
      name: /^Ask .*Show queue$/,
    })[0];
    fireEvent.click(ask);
    expect(ask.getAttribute("aria-pressed")).toBe("true");
    expect(
      screen.getByRole("region", { name: /^Level 3 · Queue at Ask / }),
    ).toBeTruthy();
    expect(
      screen.getByText("This order has nothing resting at this level"),
    ).toBeTruthy();
  });

  test("each side keeps its row count however many levels the book has", async () => {
    const { orderId } = restingBuy();
    const view = render(<OrderBookView levels={8} orderId={orderId} />, {
      wrapper: Wrapper,
    });
    await waitFor(() => {
      tick();
      expect(view.container.querySelector("tr[data-own]")).toBeTruthy();
    });
    const count = (selector: string) =>
      view.container.querySelectorAll(selector).length;
    for (let i = 0; i < 20; i++) {
      tick();
      const asks = count('.tradingOrderBookView-level[data-side="SELL"]');
      const bids = count('.tradingOrderBookView-level[data-side="BUY"]');
      expect(asks).toBeLessThan(8); // the test book is thinner than 8 levels
      expect(count(".tradingOrderBookView-level")).toBe(16);
      expect(count(".tradingOrderBookView-level-empty")).toBe(16 - asks - bids);
    }
  });

  test("Reset level returns from a picked level to the order's level", async () => {
    const { orderId } = restingBuy();
    const view = render(<OrderBookView orderId={orderId} />, {
      wrapper: Wrapper,
    });
    await waitFor(() => {
      tick();
      expect(view.container.querySelector("tr[data-own]")).toBeTruthy();
    });
    const reset = () =>
      view.container.querySelector<HTMLButtonElement>(
        ".tradingOrderBookView-reset",
      );
    // the default level: nothing to reset
    expect(reset()?.hidden).toBe(true);

    fireEvent.click(
      screen.getAllByRole("button", { name: /^Ask .*Show queue$/ })[0],
    );
    expect(
      screen.getByRole("region", { name: /^Level 3 · Queue at Ask / }),
    ).toBeTruthy();
    expect(reset()?.hidden).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Reset level" }));
    expect(
      screen.getByRole("region", { name: /^Level 3 · Queue at Bid / }),
    ).toBeTruthy();
    expect(view.container.querySelector("tr[data-own]")).toBeTruthy();
    expect(reset()?.hidden).toBe(true);
  });

  test("without an order it asks for one", () => {
    render(<OrderBookView />, { wrapper: Wrapper });
    expect(screen.getByText("Select an order to see its book")).toBeTruthy();
  });

  test("the blotter's Order book button opens the panel (a dialog outside a shell)", async () => {
    render(<OrderBlotter />, { wrapper: Wrapper });
    fireEvent.click(screen.getByRole("button", { name: "Show order book" }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    expect(screen.getByRole("dialog").textContent).toContain(
      "Select an order to see its book",
    );
  });
});

describe("OrderBookView with a long-running algo order", () => {
  test("shows the live slices of an order with hundreds of finished children", async () => {
    setCurrentUser({ name: "admin", authorizations: [] });
    const testData = createTradingTestData({
      seed: 21,
      exchange: { activeInstruments: 5 },
      oms: { flowRate: 0 },
      manualClock: true,
    });
    try {
      testData.advance(5_000);
      const engine = testData.omsService.engine;
      const result = engine.createOrder(
        {
          account: "ACC-US-01",
          ric: testData.sim.books[0].ric,
          side: Side.Buy,
          ordType: OrdType.Market,
          quantity: 4_000,
          timeInForce: TimeInForce.Day,
          strategy: AlgoStrategy.Vwap,
          durationMins: 30,
        },
        { user: "admin" },
      );
      if (!result.ok) throw Error(`order rejected: ${result.text}`);
      const { orderId } = result.value;
      // the VWAP re-places its slices several times a second
      testData.advance(5 * 60_000);
      const children = () =>
        [...engine.children.values()].filter(
          (c) => c.parentOrderId === orderId,
        );
      expect(children().length).toBeGreaterThan(500);

      const localServer = createTradingLocalServer(testData, "order-book-algo");
      const view = render(<OrderBookView orderId={orderId} />, {
        wrapper: ({ children }: { children: ReactNode }) => (
          <TradingDataProvider mode="local" localServer={localServer}>
            {children}
          </TradingDataProvider>
        ),
      });
      await waitFor(() => {
        act(() => testData.advance(100));
        expect(
          view.container.querySelector(".tradingOrderBookView-level"),
        ).toBeTruthy();
      });
      let resting = 0;
      let shown = 0;
      for (let i = 0; i < 40; i++) {
        await act(async () => {
          testData.advance(250);
          await new Promise((resolve) => setTimeout(resolve, 20));
        });
        const live = children().some(
          (c) => isWorkingStatus(c.state.status) && c.exchangeOrderId,
        );
        if (!live) continue;
        resting++;
        if (view.container.querySelector(".tradingOrderBookView-chip")) shown++;
      }
      expect(resting).toBeGreaterThan(0);
      expect(shown).toBe(resting);
    } finally {
      testData.dispose();
    }
  }, 60_000);
});
