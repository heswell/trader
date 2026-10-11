import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { stepTicks } from "@heswell/trading-schemas";
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
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import {
  InstrumentContextProvider,
  MarketDepth,
  TradingDataProvider,
  useSelectedInstrument,
} from "../src";

setCurrentUser({ name: "admin", authorizations: [] });
const testData = createTradingTestData({
  seed: 11,
  exchange: { activeInstruments: 5 },
  oms: { flowRate: 0 },
  manualClock: true,
});
testData.advance(2_000);
const localServer = createTradingLocalServer(testData, "market-depth-test");
const [bookA, bookB] = testData.sim.books;

afterEach(cleanup);
afterAll(() => testData.dispose());

const Wrapper = ({ children }: { children: ReactNode }) => (
  <TradingDataProvider mode="local" localServer={localServer}>
    <InstrumentContextProvider>{children}</InstrumentContextProvider>
  </TradingDataProvider>
);

const Select = ({ ric }: { ric: string }) => {
  const { setSelectedInstrument } = useSelectedInstrument();
  return (
    <button
      type="button"
      onClick={() => setSelectedInstrument({ ric }, "test")}
    >
      {`select ${ric}`}
    </button>
  );
};

const priceCells = (table: HTMLElement, side: "bid" | "ask") =>
  Array.from(
    table.querySelectorAll<HTMLElement>(
      `td.tradingMarketDepth-${side}.tradingMarketDepth-price:not([data-empty])`,
    ),
  ).map((td) => Number(td.textContent?.replace(/,/g, "")));

describe("MarketDepth", () => {
  test("shows a prompt when there is no instrument", () => {
    render(<MarketDepth />, { wrapper: Wrapper });
    expect(screen.getByText("Select an instrument")).toBeTruthy();
  });

  test("renders both sides of the book, best first, with a spread row", async () => {
    render(<MarketDepth ric={bookA.ric} levels={5} />, { wrapper: Wrapper });
    const table = await screen.findByRole("table", {
      name: `Market depth ${bookA.ric}`,
    });
    await waitFor(() => {
      expect(priceCells(table, "bid").length).toBeGreaterThan(0);
      expect(priceCells(table, "ask").length).toBeGreaterThan(0);
    });
    // header row + 5 level rows
    expect(within(table).getAllByRole("row")).toHaveLength(6);
    expect(
      within(table).getByRole("columnheader", { name: "Bid qty" }),
    ).toBeTruthy();
    const bids = priceCells(table, "bid");
    const asks = priceCells(table, "ask");
    expect(bids).toEqual([...bids].sort((a, b) => b - a));
    expect(asks).toEqual([...asks].sort((a, b) => a - b));
    expect(bids[0]).toBeLessThan(asks[0]);
    const top = bookA.topOfBook();
    expect(bids[0]).toBeCloseTo(top.bid, 6);
    expect(asks[0]).toBeCloseTo(top.ask, 6);
    expect(screen.getByText(/Spread/).textContent).toContain("Mid");
    // depth bars are proportional to cumulative quantity
    const bars = table.querySelectorAll<HTMLElement>(
      ".tradingMarketDepth-bid .tradingMarketDepth-bar",
    );
    expect(bars.length).toBe(bids.length);
  });

  test("follows the selected instrument without showing stale rows", async () => {
    render(
      <>
        <Select ric={bookA.ric} />
        <Select ric={bookB.ric} />
        <MarketDepth />
      </>,
      { wrapper: Wrapper },
    );
    fireEvent.click(screen.getByText(`select ${bookA.ric}`));
    const tableA = await screen.findByRole("table", {
      name: `Market depth ${bookA.ric}`,
    });
    await waitFor(() =>
      expect(priceCells(tableA, "bid")[0]).toBeCloseTo(
        bookA.topOfBook().bid,
        6,
      ),
    );
    fireEvent.click(screen.getByText(`select ${bookB.ric}`));
    // never renders A's prices under B's caption
    const tableB = screen.getByRole("table", {
      name: `Market depth ${bookB.ric}`,
    });
    // rows are cleared on switch: either empty or already B's book
    const immediate = priceCells(tableB, "bid");
    if (immediate.length > 0) {
      expect(immediate[0]).toBeCloseTo(bookB.topOfBook().bid, 6);
    }
    await waitFor(() =>
      expect(priceCells(tableB, "bid")[0]).toBeCloseTo(
        bookB.topOfBook().bid,
        6,
      ),
    );
  });

  test("marks own working orders at their price level", async () => {
    render(<MarketDepth ric={bookA.ric} account="ACC-US-01" />, {
      wrapper: Wrapper,
    });
    const table = await screen.findByRole("table", {
      name: `Market depth ${bookA.ric}`,
    });
    await waitFor(() =>
      expect(priceCells(table, "bid").length).toBeGreaterThan(0),
    );
    // rest a few ticks behind the touch so it isn't filled
    const price = stepTicks(bookA.topOfBook().bid, bookA.schedule, -3);
    act(() => {
      testData.rpc("createOrder", {
        account: "ACC-US-01",
        ric: bookA.ric,
        side: "BUY",
        ordType: "LIMIT",
        quantity: 700,
        price,
        clOrdId: "md-test-1",
      });
      testData.advance(200);
    });
    await waitFor(() => {
      const marker = table.querySelector(".tradingMarketDepth-ownMarker");
      expect(marker?.textContent).toContain("own");
      expect(marker?.textContent).toContain("700");
    });
  });

  test("shows the trading phase when the instrument is halted", async () => {
    const { container } = render(<MarketDepth ric={bookB.ric} />, {
      wrapper: Wrapper,
    });
    await screen.findByRole("table", { name: `Market depth ${bookB.ric}` });
    act(() => {
      testData.rpc("haltInstrument", { ric: bookB.ric });
      testData.advance(200);
    });
    await waitFor(() =>
      expect(
        container.querySelector<HTMLElement>(".tradingMarketDepth")?.dataset
          .phase,
      ).toBe("HALTED"),
    );
    expect(screen.getAllByText("Trading halted").length).toBeGreaterThan(0);
    act(() => {
      testData.rpc("resumeInstrument", { ric: bookB.ric });
      testData.advance(200);
    });
  });

  test("reports level clicks", async () => {
    const clicks: unknown[] = [];
    render(
      <MarketDepth ric={bookA.ric} onLevelClick={(e) => clicks.push(e)} />,
      { wrapper: Wrapper },
    );
    const table = await screen.findByRole("table", {
      name: `Market depth ${bookA.ric}`,
    });
    await waitFor(() =>
      expect(priceCells(table, "ask").length).toBeGreaterThan(0),
    );
    const ask = priceCells(table, "ask")[0];
    fireEvent.click(within(table).getAllByRole("button", { name: /^Ask / })[0]);
    expect(clicks).toEqual([{ side: "SELL", price: ask, level: 0 }]);
  });
});
