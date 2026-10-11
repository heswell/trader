import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import {
  OrdStatus,
  Side,
  stepTicks,
  tickScheduleOf,
} from "@heswell/trading-schemas";
import {
  createTradingLocalServer,
  createTradingTestData,
  setCurrentUser,
} from "@heswell/trading-test-data";
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
  centreIndex,
  ladderPrices,
  ladderReferencePrice,
  needsRecentre,
  type OwnOrder,
  type OwnOrdersAtPrice,
  ownOrdersKey,
  PriceLadder,
  type PriceLadderOrderEvent,
  PriceLadderView,
  TradingDataProvider,
  type TradingRpcError,
} from "../src";

afterEach(cleanup);

describe("ladderPrices", () => {
  const schedule = tickScheduleOf({ tickSize: 0.5 });
  test("one row per tick, highest first, centred", () => {
    const prices = ladderPrices(100, schedule, 5);
    expect(prices).toEqual([101, 100.5, 100, 99.5, 99]);
    expect(prices[centreIndex(prices.length)]).toBe(100);
  });

  test("follows tick bands", () => {
    const banded = tickScheduleOf({
      tickSize: 0.01,
      tickBands: "0:0.01;10:0.05",
    });
    expect(ladderPrices(10, banded, 5)).toEqual([10.1, 10.05, 10, 9.99, 9.98]);
  });

  test("reference price is the mid rounded down to a tick, else last / fallback", () => {
    expect(ladderReferencePrice(schedule, { bestBid: 100, bestAsk: 101 })).toBe(
      100.5,
    );
    expect(
      ladderReferencePrice(schedule, { bestBid: 100, bestAsk: 100.5 }),
    ).toBe(100);
    expect(ladderReferencePrice(schedule, { last: 99.5 })).toBe(99.5);
    expect(ladderReferencePrice(schedule, { fallback: 98 })).toBe(98);
    expect(ladderReferencePrice(schedule, {})).toBeUndefined();
  });

  test("recentres only when the reference leaves the middle half", () => {
    const prices = ladderPrices(100, schedule, 9); // 102 .. 98
    expect(needsRecentre(prices, 100.5)).toBe(false);
    expect(needsRecentre(prices, 101.5)).toBe(true);
    expect(needsRecentre(prices, 97)).toBe(true);
  });
});

const schedule = tickScheduleOf({ tickSize: 0.5 });
const bids = [
  { price: 100, size: 500 },
  { price: 99.5, size: 1_200 },
  { price: 99, size: 300 },
];
const asks = [
  { price: 101, size: 400 },
  { price: 101.5, size: 900 },
];
const ownOrder = (overrides: Partial<OwnOrder>): OwnOrder => ({
  orderId: "O-1",
  clOrdId: "C-1",
  account: "ACC-US-01",
  ric: "TEST.L",
  side: Side.Buy,
  price: 99.5,
  quantity: 200,
  leavesQty: 200,
  cumQty: 0,
  status: OrdStatus.New,
  ...overrides,
});
const ownMap = (orders: OwnOrder[]) => {
  const map = new Map<string, OwnOrdersAtPrice>();
  for (const o of orders) {
    const key = ownOrdersKey(o.side, o.price);
    const entry = map.get(key) ?? {
      side: o.side,
      price: o.price,
      quantity: 0,
      orders: [],
    };
    entry.quantity += o.leavesQty;
    entry.orders.push(o);
    map.set(key, entry);
  }
  return map;
};

const grid = () => screen.getByRole("grid");
const row = (price: number) =>
  grid().querySelector<HTMLElement>(`tr[data-price="${price}"]`);
const cell = (price: number, col: string) =>
  row(price)?.querySelector<HTMLElement>(`[data-col="${col}"]`) ?? null;
const activeCell = () => {
  const id = grid().getAttribute("aria-activedescendant");
  return id ? document.getElementById(id) : null;
};

describe("PriceLadderView", () => {
  test("renders a tick ladder centred on the mid with best bid / ask and LTP", () => {
    render(
      <PriceLadderView
        ric="TEST.L"
        tickSchedule={schedule}
        bids={bids}
        asks={asks}
        last={100}
        rowCount={11}
      />,
    );
    const rows = grid().querySelectorAll("tbody tr");
    expect(rows).toHaveLength(11);
    // centre row is the mid (100.5) rounded to tick
    expect((rows[5] as HTMLElement).dataset.price).toBe("100.5");
    expect(row(100)?.dataset.bestBid).toBe("true");
    expect(row(101)?.dataset.bestAsk).toBe("true");
    expect(row(100)?.dataset.ltp).toBe("true");
    expect(row(100.5)?.dataset.spread).toBe("true");
    expect(cell(99.5, "bid")?.textContent).toContain("1,200");
    expect(cell(101.5, "ask")?.textContent).toContain("900");
    expect(screen.getByRole("columnheader", { name: "My bids" })).toBeTruthy();
    expect(grid().getAttribute("aria-describedby")).toBeTruthy();
  });

  test("click-to-trade asks for confirmation in confirm mode", () => {
    const onTrade = mock();
    render(
      <PriceLadderView
        tickSchedule={schedule}
        bids={bids}
        asks={asks}
        rowCount={11}
        defaultQuantity={300}
        onTrade={onTrade}
      />,
    );
    fireEvent.click(cell(99.5, "bid") as HTMLElement);
    expect(onTrade).not.toHaveBeenCalled();
    const confirm = screen.getByRole("group", { name: "Confirm order" });
    expect(confirm.textContent).toContain("Buy 300");
    fireEvent.click(screen.getByRole("button", { name: "Buy" }));
    expect(onTrade).toHaveBeenCalledWith({
      side: Side.Buy,
      price: 99.5,
      quantity: 300,
    });
    expect(screen.queryByRole("group", { name: "Confirm order" })).toBeNull();
  });

  test("one-click mode trades immediately on the ask column", () => {
    const onTrade = mock();
    render(
      <PriceLadderView
        tickSchedule={schedule}
        bids={bids}
        asks={asks}
        rowCount={11}
        defaultTradeMode="one-click"
        onTrade={onTrade}
      />,
    );
    fireEvent.click(cell(101.5, "ask") as HTMLElement);
    expect(onTrade).toHaveBeenCalledWith({
      side: Side.Sell,
      price: 101.5,
      quantity: 100,
    });
  });

  test("keyboard: arrows move the cursor, B / S trade, Enter confirms, C centres", () => {
    const onTrade = mock();
    render(
      <PriceLadderView
        tickSchedule={schedule}
        bids={bids}
        asks={asks}
        rowCount={11}
        onTrade={onTrade}
      />,
    );
    const g = grid();
    fireEvent.focus(g);
    expect(activeCell()?.closest("tr")?.dataset.price).toBe("100.5");
    fireEvent.keyDown(g, { key: "ArrowDown" });
    fireEvent.keyDown(g, { key: "ArrowDown" });
    expect(activeCell()?.closest("tr")?.dataset.price).toBe("99.5");
    expect(activeCell()?.dataset.col).toBe("price");
    fireEvent.keyDown(g, { key: "ArrowLeft" });
    expect(activeCell()?.dataset.col).toBe("bid");
    fireEvent.keyDown(g, { key: "b" });
    expect(screen.getByRole("group", { name: "Confirm order" })).toBeTruthy();
    fireEvent.keyDown(g, { key: "Enter" });
    expect(onTrade).toHaveBeenLastCalledWith({
      side: Side.Buy,
      price: 99.5,
      quantity: 100,
    });
    fireEvent.keyDown(g, { key: "s" });
    fireEvent.keyDown(g, { key: "Escape" });
    expect(onTrade).toHaveBeenCalledTimes(1);
    // scrolling switches auto-centre off; C re-centres
    for (let i = 0; i < 8; i++) fireEvent.keyDown(g, { key: "ArrowUp" });
    expect(screen.getByRole("button", { name: /Auto-centre/ })).toBeTruthy();
    fireEvent.keyDown(g, { key: "c" });
    expect(activeCell()?.closest("tr")?.dataset.price).toBe("100.5");
  });

  test("Delete cancels own orders at the cursor level; M + arrows + Enter amends", () => {
    const onCancelOrders = mock();
    const onAmendOrders = mock();
    const orders = [
      ownOrder({ orderId: "O-1" }),
      ownOrder({ orderId: "O-2", quantity: 100, leavesQty: 100 }),
      ownOrder({ orderId: "O-3", status: OrdStatus.PendingNew }),
    ];
    render(
      <PriceLadderView
        tickSchedule={schedule}
        bids={bids}
        asks={asks}
        rowCount={11}
        ownOrders={ownMap(orders)}
        onCancelOrders={onCancelOrders}
        onAmendOrders={onAmendOrders}
      />,
    );
    expect(cell(99.5, "ownBuy")?.textContent).toBe("500 (3)");
    const g = grid();
    fireEvent.focus(g);
    fireEvent.keyDown(g, { key: "ArrowDown" });
    fireEvent.keyDown(g, { key: "ArrowDown" });
    fireEvent.keyDown(g, { key: "Delete" });
    // pending orders aren't cancellable yet
    expect(onCancelOrders).toHaveBeenCalledWith([orders[0], orders[1]], 99.5);

    fireEvent.keyDown(g, { key: "m" });
    expect(row(99.5)?.dataset.moving).toBe("true");
    fireEvent.keyDown(g, { key: "ArrowDown" });
    expect(row(99)?.dataset.dropTarget).toBe("true");
    expect(
      screen.getByText(/Moving buy orders from 99\.50 to 99\.00/),
    ).toBeTruthy();
    fireEvent.keyDown(g, { key: "Enter" });
    expect(onAmendOrders).toHaveBeenCalledWith([orders[0], orders[1]], 99);
  });

  test("double-click and drag own orders", () => {
    const onCancelOrders = mock();
    const onAmendOrders = mock();
    const order = ownOrder({ side: Side.Sell, price: 101.5 });
    render(
      <PriceLadderView
        tickSchedule={schedule}
        bids={bids}
        asks={asks}
        rowCount={11}
        ownOrders={ownMap([order])}
        onCancelOrders={onCancelOrders}
        onAmendOrders={onAmendOrders}
      />,
    );
    fireEvent.doubleClick(cell(101.5, "ownSell") as HTMLElement);
    expect(onCancelOrders).toHaveBeenCalledWith([order], 101.5);
    fireEvent.pointerDown(cell(101.5, "ownSell") as HTMLElement, {
      button: 0,
    });
    fireEvent.pointerOver(cell(102, "ownSell") as HTMLElement);
    fireEvent.pointerUp(cell(102, "ownSell") as HTMLElement);
    expect(onAmendOrders).toHaveBeenCalledWith([order], 102);
  });

  test("disabled trading shows the reason and ignores trade clicks", () => {
    const onTrade = mock();
    render(
      <PriceLadderView
        tickSchedule={schedule}
        bids={bids}
        asks={asks}
        rowCount={11}
        defaultTradeMode="one-click"
        tradingEnabled={false}
        disabledReason="Trading halted"
        onTrade={onTrade}
      />,
    );
    fireEvent.click(cell(100, "bid") as HTMLElement);
    expect(onTrade).not.toHaveBeenCalled();
    expect(screen.getByText("Trading halted")).toBeTruthy();
  });

  test("shows a prompt without an instrument", () => {
    render(<PriceLadderView />);
    expect(screen.getByText("Select an instrument")).toBeTruthy();
  });
});

describe("PriceLadder (local data)", () => {
  setCurrentUser({ name: "admin", authorizations: [] });
  const testData = createTradingTestData({
    seed: 21,
    exchange: { activeInstruments: 5 },
    oms: { flowRate: 0 },
    manualClock: true,
  });
  testData.advance(2_000);
  const localServer = createTradingLocalServer(testData, "price-ladder-test");
  const book = testData.sim.books[0];
  afterAll(() => testData.dispose());

  const Wrapper = ({ children }: { children: ReactNode }) => (
    <TradingDataProvider mode="local" localServer={localServer}>
      {children}
    </TradingDataProvider>
  );
  /** Let the engines publish while waiting. */
  const tick = () => act(() => testData.advance(100));

  test("trades, cancels and amends through OMS RPCs", async () => {
    const events: PriceLadderOrderEvent[] = [];
    render(
      <PriceLadder
        ric={book.ric}
        account="ACC-US-01"
        rowCount={41}
        defaultTradeMode="one-click"
        defaultQuantity={400}
        defaultAutoCentre={false}
        onOrderEvent={(e) => events.push(e)}
      />,
      { wrapper: Wrapper },
    );
    await waitFor(() => {
      tick();
      expect(grid().querySelector('[data-best-bid="true"]')).toBeTruthy();
    });
    const price = stepTicks(book.topOfBook().bid, book.schedule, -3);
    fireEvent.click(cell(price, "bid") as HTMLElement);
    await waitFor(() => expect(events.map((e) => e.type)).toEqual(["create"]));
    const created = events[0] as Extract<
      PriceLadderOrderEvent,
      { type: "create" }
    >;
    expect(created.request).toMatchObject({
      account: "ACC-US-01",
      ric: book.ric,
      side: "BUY",
      price,
      quantity: 400,
    });
    expect(created.request.clOrdId).toMatch(/^LDR-/);
    await waitFor(() => {
      tick();
      expect(cell(price, "ownBuy")?.textContent).toBe("400");
    });

    // keyboard move one tick down = amendOrder
    const g = grid();
    const target = stepTicks(price, book.schedule, -1);
    fireEvent.focus(g);
    fireEvent.click(cell(price, "ownBuy") as HTMLElement);
    fireEvent.keyDown(g, { key: "m" });
    fireEvent.keyDown(g, { key: "ArrowDown" });
    fireEvent.keyDown(g, { key: "Enter" });
    await waitFor(() => expect(events.at(-1)?.type).toBe("amend"));
    await waitFor(() => {
      tick();
      expect(cell(target, "ownBuy")?.textContent).toBe("400");
      expect(cell(price, "ownBuy")?.textContent).toBe("");
    });

    // Delete at the cursor = cancelOrder
    fireEvent.click(cell(target, "ownBuy") as HTMLElement);
    fireEvent.keyDown(g, { key: "Delete" });
    await waitFor(() => expect(events.at(-1)?.type).toBe("cancel"));
    await waitFor(() => {
      tick();
      expect(cell(target, "ownBuy")?.textContent).toBe("");
    });
  });

  test("cancel all and rejected orders surface through callbacks", async () => {
    const events: PriceLadderOrderEvent[] = [];
    const errors: TradingRpcError[] = [];
    render(
      <PriceLadder
        ric={book.ric}
        account="ACC-US-01"
        rowCount={41}
        defaultTradeMode="one-click"
        defaultAutoCentre={false}
        defaultQuantity={1_000_000}
        onOrderEvent={(e) => events.push(e)}
        onError={(e) => errors.push(e)}
      />,
      { wrapper: Wrapper },
    );
    await waitFor(() => {
      tick();
      expect(grid().querySelector('[data-best-ask="true"]')).toBeTruthy();
    });
    const price = stepTicks(book.topOfBook().ask, book.schedule, 3);
    fireEvent.click(cell(price, "ask") as HTMLElement);
    await waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0].rpcName).toBe("createOrder");
    expect(errors[0].reason).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain(errors[0].reason);

    const resting = stepTicks(book.topOfBook().bid, book.schedule, -4);
    act(() => {
      testData.rpc("createOrder", {
        account: "ACC-US-01",
        ric: book.ric,
        side: "BUY",
        ordType: "LIMIT",
        quantity: 100,
        price: resting,
        clOrdId: "ladder-test-ca",
      });
    });
    await waitFor(() => {
      tick();
      expect(cell(resting, "ownBuy")?.textContent).toBe("100");
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel all" }));
    await waitFor(() => expect(events.at(-1)?.type).toBe("cancelAll"));
  });

  test("is view-only without an account", async () => {
    render(<PriceLadder ric={book.ric} rowCount={21} />, { wrapper: Wrapper });
    await waitFor(() => {
      tick();
      expect(screen.getByText("No account: view only")).toBeTruthy();
    });
  });
});
