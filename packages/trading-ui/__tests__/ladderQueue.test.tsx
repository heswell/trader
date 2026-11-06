import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { Side, tickScheduleOf } from "@heswell/trading-schemas";
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
  type BookOrderRow,
  buildLadderQueues,
  compactQuantity,
  type LadderQueue,
  ownOrdersKey,
  PriceLadder,
  type PriceLadderOrderEvent,
  PriceLadderView,
  queuePositionText,
  queueSegments,
  TradingDataProvider,
} from "../src";

afterEach(cleanup);

const order = (
  orderId: string,
  side: Side,
  price: number,
  size: number,
  priority: number,
): BookOrderRow => ({ orderId, side, price, size, priority, entryTime: 0 });

describe("buildLadderQueues", () => {
  const rows = [
    order("c", Side.Buy, 100, 300, 7),
    order("a", Side.Buy, 100, 500, 2),
    order("b", Side.Buy, 100, 200, 5),
    order("s", Side.Sell, 101, 50, 1),
  ];

  test("groups by side and price, front of the queue first", () => {
    const queues = buildLadderQueues(rows, new Set(["b"]));
    const bid = queues.get(ownOrdersKey(Side.Buy, 100)) as LadderQueue;
    expect(bid.orders.map((o) => o.orderId)).toEqual(["a", "b", "c"]);
    expect(bid.total).toBe(1_000);
    expect(bid.ownRank).toBe(2);
    expect(bid.ownAhead).toBe(500);
    const ask = queues.get(ownOrdersKey(Side.Sell, 101)) as LadderQueue;
    expect(ask.ownRank).toBeUndefined();
  });

  test("an unchanged level keeps its object", () => {
    const own = new Set(["b"]);
    const first = buildLadderQueues(rows, own);
    const next = buildLadderQueues(
      [...rows.slice(0, 3), order("s", Side.Sell, 101, 40, 1)],
      own,
      first,
    );
    const bidKey = ownOrdersKey(Side.Buy, 100);
    const askKey = ownOrdersKey(Side.Sell, 101);
    expect(next.get(bidKey)).toBe(first.get(bidKey) as LadderQueue);
    expect(next.get(askKey)).not.toBe(first.get(askKey) as LadderQueue);
    // a change of ownership is a change
    const mine = buildLadderQueues(rows, new Set(["a"]), first);
    expect(mine.get(bidKey)?.ownRank).toBe(1);
  });
});

describe("queue helpers", () => {
  test("compactQuantity", () => {
    expect(compactQuantity(950)).toBe("950");
    expect(compactQuantity(1_234)).toBe("1.2k");
    expect(compactQuantity(12_400)).toBe("12k");
    expect(compactQuantity(1_500_000)).toBe("1.5M");
  });

  test("queuePositionText", () => {
    const queue = buildLadderQueues(
      [order("a", Side.Buy, 1, 900, 1), order("b", Side.Buy, 1, 1, 2)],
      new Set(["b"]),
    ).get(ownOrdersKey(Side.Buy, 1));
    expect(queuePositionText(queue)).toBe("2nd in queue, 900 ahead");
    expect(queuePositionText(undefined)).toBeUndefined();
  });

  test("small orders merge; own orders never do", () => {
    const rows = [
      order("a", Side.Buy, 1, 500, 1),
      order("b", Side.Buy, 1, 5, 2),
      order("c", Side.Buy, 1, 5, 3),
      order("own", Side.Buy, 1, 5, 4),
      order("d", Side.Buy, 1, 5, 5),
    ];
    const queue = buildLadderQueues(rows, new Set(["own"])).get(
      ownOrdersKey(Side.Buy, 1),
    ) as LadderQueue;
    expect(queueSegments(queue, 1_000)).toEqual([
      { size: 500, own: false, count: 1 },
      { size: 10, own: false, count: 2 },
      { size: 5, own: true, count: 1 },
      { size: 5, own: false, count: 1 },
    ]);
  });

  test("long queues are capped at 12 segments", () => {
    const rows = Array.from({ length: 30 }, (_, i) =>
      order(`o${i}`, Side.Buy, 1, 100, i),
    );
    const queue = buildLadderQueues(rows, undefined).get(
      ownOrdersKey(Side.Buy, 1),
    ) as LadderQueue;
    const segments = queueSegments(queue, 1_000);
    expect(segments).toHaveLength(12);
    expect(segments.at(-1)).toEqual({ size: 1_900, own: false, count: 19 });
  });
});

const schedule = tickScheduleOf({ tickSize: 0.5 });
const grid = () => screen.getByRole("grid");
const cell = (price: number, col: string) =>
  grid().querySelector<HTMLElement>(
    `tr[data-price="${price}"] [data-col="${col}"]`,
  );

describe("PriceLadderView queue", () => {
  const queues = buildLadderQueues(
    [
      order("a", Side.Buy, 100, 300, 1),
      order("x", Side.Buy, 100, 200, 2),
      order("b", Side.Buy, 100, 100, 3),
      order("s", Side.Sell, 101, 400, 4),
    ],
    new Set(["x"]),
  );
  const view = (props: Partial<Parameters<typeof PriceLadderView>[0]> = {}) => (
    <PriceLadderView
      tickSchedule={schedule}
      bids={[{ price: 100, size: 600 }]}
      asks={[{ price: 101, size: 400 }]}
      rowCount={11}
      queues={queues}
      {...props}
    />
  );

  test("no Queue toggle without queues", () => {
    render(view({ queues: undefined }));
    expect(screen.queryByRole("button", { name: "Queue" })).toBeNull();
  });

  test("the Queue toggle splits the bars and shows the own position", () => {
    render(view());
    expect(cell(100, "bid")?.querySelectorAll("[data-own]")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Queue" }));
    const bid = cell(100, "bid") as HTMLElement;
    const segments = bid.querySelectorAll(".tradingPriceLadder-segment");
    expect(segments).toHaveLength(3);
    expect(segments[1].hasAttribute("data-own")).toBe(true);
    expect(bid.getAttribute("aria-label")).toBe(
      "bid 600, 3 orders, mine 2nd in queue, 300 ahead",
    );
    expect(cell(100, "ownBuy")?.textContent).toBe("#2·300");
  });

  test("Q opens the panel for the cursor row; Escape closes it", () => {
    render(view());
    const g = grid();
    fireEvent.click(cell(100, "price") as HTMLElement);
    fireEvent.keyDown(g, { key: "ArrowLeft" });
    fireEvent.keyDown(g, { key: "q" });
    const panel = screen.getByRole("region", { name: /^Bid queue at 100/ });
    const rows = panel.querySelectorAll("tbody tr");
    expect(
      [...rows].map((r) =>
        [...r.querySelectorAll("td")].slice(0, 3).map((td) => td.textContent),
      ),
    ).toEqual([
      ["1", "300", "0"],
      ["2 · yours", "200", "300"],
      ["3", "100", "500"],
    ]);
    expect(rows[1].hasAttribute("data-own")).toBe(true);
    // the panel follows the cursor; the price column of an ask row is the ask side
    fireEvent.keyDown(g, { key: "ArrowRight" });
    fireEvent.keyDown(g, { key: "ArrowUp" });
    fireEvent.keyDown(g, { key: "ArrowUp" });
    expect(
      screen.getByRole("region", { name: /^Ask queue at 101/ }),
    ).toBeTruthy();
    fireEvent.keyDown(g, { key: "Escape" });
    expect(screen.queryByRole("region", { name: /queue at/ })).toBeNull();
  });

  test("Queue on shows why there are no queues", () => {
    render(
      view({
        defaultShowQueue: true,
        queueUnavailableReason:
          "Order-by-order data isn't enabled on this server",
      }),
    );
    expect(screen.getByRole("status").textContent).toBe(
      "Order-by-order data isn't enabled on this server",
    );
  });
});

describe("PriceLadder queue (local data)", () => {
  setCurrentUser({ name: "admin", authorizations: [] });
  const testData = createTradingTestData({
    seed: 21,
    exchange: { activeInstruments: 5 },
    oms: { flowRate: 0 },
    manualClock: true,
  });
  testData.advance(2_000);
  const localServer = createTradingLocalServer(testData, "ladder-queue-test");
  const book = testData.sim.books[0];
  afterAll(() => testData.dispose());

  const Wrapper = ({ children }: { children: ReactNode }) => (
    <TradingDataProvider mode="local" localServer={localServer}>
      {children}
    </TradingDataProvider>
  );
  const tick = () => act(() => testData.advance(100));

  test("marks the user's order in the live L3 queue", async () => {
    const events: PriceLadderOrderEvent[] = [];
    render(
      <PriceLadder
        ric={book.ric}
        account="ACC-US-01"
        rowCount={41}
        defaultTradeMode="one-click"
        defaultQuantity={400}
        defaultAutoCentre={false}
        defaultShowQueue
        onOrderEvent={(e) => events.push(e)}
      />,
      { wrapper: Wrapper },
    );
    await waitFor(() => {
      tick();
      expect(grid().querySelector('[data-best-bid="true"]')).toBeTruthy();
    });
    // join the back of the best bid's queue
    const price = book.topOfBook().bid;
    const ahead = book.book
      .snapshot()
      .bids.find((level) => level.price === price)
      ?.orders.reduce((sum, o) => sum + o.size, 0);
    expect(ahead).toBeGreaterThan(0);
    fireEvent.click(cell(price, "bid") as HTMLElement);
    await waitFor(() => expect(events.map((e) => e.type)).toEqual(["create"]));
    await waitFor(() => {
      tick();
      expect(
        cell(price, "bid")?.querySelector(
          ".tradingPriceLadder-segment[data-own]",
        ),
      ).toBeTruthy();
    });
    const own = cell(price, "ownBuy") as HTMLElement;
    expect(
      own.querySelector(".tradingPriceLadder-queuePos")?.textContent,
    ).toMatch(/^#\d+·/);
    expect(own.getAttribute("aria-label")).toMatch(/in queue, [\d,]+ ahead$/);
  });
});
