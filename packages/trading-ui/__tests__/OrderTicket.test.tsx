import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  createTradingLocalServer,
  createTradingTestData,
  setCurrentUser,
} from "@heswell/trading-test-data";
import {
  OrdStatus,
  OrdType,
  roundToTick,
  Side,
} from "@heswell/trading-schemas";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  InstrumentContextProvider,
  OrderTicket,
  type OrderTicketPrefill,
  scheduleOf,
  type TradingOrderEvent,
  TradingDataProvider,
} from "../src";

setCurrentUser({ name: "admin", authorizations: [] });
const td = createTradingTestData({
  seed: 7,
  exchange: { activeInstruments: 5 },
  oms: { flowRate: 0 },
  manualClock: true,
});
td.advance(2_000);
const localServer = createTradingLocalServer(td, "order-ticket-test");
const ric = td.sim.books[0].ric;
const ACCOUNT = "ACC-US-01";

const instrumentRow = () => {
  const t = td.exchange.getTable("instrumentPrices");
  const row = t.findByKey(ric);
  if (!row) throw Error(`no instrumentPrices row for ${ric}`);
  const get = (c: string) => row[t.map[c]];
  return {
    ric,
    tickSize: get("tickSize") as number,
    tickBands: get("tickBands") as string,
    lotSize: get("lotSize") as number,
    bid: get("bid") as number,
    last: get("last") as number,
  };
};

afterEach(cleanup);
afterAll(() => td.dispose());

const renderTicket = (prefill: OrderTicketPrefill) => {
  const events: TradingOrderEvent[] = [];
  const closed: number[] = [];
  render(
    <TradingDataProvider localServer={localServer} mode="local">
      <InstrumentContextProvider>
        <OrderTicket
          followSelection={false}
          onClose={() => closed.push(1)}
          onOrderEvent={(e) => events.push(e)}
          prefill={prefill}
          rememberAccount={false}
        />
      </InstrumentContextProvider>
    </TradingDataProvider>,
  );
  return { events, closed, form: screen.getByRole("form") };
};

const submitButton = () =>
  document.querySelector(".tradingOrderTicket-submit") as HTMLButtonElement;

const waitForInstrument = () =>
  waitFor(() =>
    expect(document.querySelector('[data-field="last"]')?.textContent).toMatch(
      /\d/,
    ),
  );

describe("OrderTicket", () => {
  test("shows validation errors and does not submit an invalid order", async () => {
    const lot = instrumentRow().lotSize;
    const { events, form } = renderTicket({
      ric,
      account: ACCOUNT,
      ordType: OrdType.Limit,
      quantity: lot > 1 ? lot + 1 : 1.5,
      price: undefined,
    });
    await waitForInstrument();
    act(() => {
      fireEvent.keyDown(form, { key: "F9" });
    });
    await waitFor(() =>
      expect(
        form.querySelectorAll('[aria-invalid="true"], .saltFormFieldHelperText')
          .length,
      ).toBeGreaterThan(0),
    );
    expect(form.textContent).toContain("Enter a limit price");
    expect(events).toHaveLength(0);
  });

  test("submits a market order and shows the fill", async () => {
    const { lotSize } = instrumentRow();
    const { events, form } = renderTicket({
      ric,
      account: ACCOUNT,
      side: Side.Buy,
      ordType: OrdType.Market,
      quantity: lotSize,
    });
    await waitForInstrument();
    await waitFor(() =>
      expect(submitButton().textContent).toContain(`Buy ${lotSize}`),
    );
    await act(async () => {
      fireEvent.click(submitButton());
    });
    await waitFor(() => expect(events.length).toBeGreaterThan(0));
    const first = events[0];
    expect(first.clOrdId).toBeString();
    expect(["ack", "filled", "submitted"]).toContain(first.kind);
    act(() => td.advance(500));
    await waitFor(() => {
      const status = form.querySelector(".tradingOrderTicket-status");
      expect(status?.getAttribute("data-status")).toBe(OrdStatus.Filled);
    });
    const orders = td.oms.getTable("parentOrders");
    const row = orders.data.find(
      (r) => r[orders.map.clOrdId] === first.clOrdId,
    );
    expect(row?.[orders.map.status]).toBe(OrdStatus.Filled);
  });

  test("shows a risk reject (price outside collar)", async () => {
    const inst = instrumentRow();
    const schedule = scheduleOf(inst);
    if (!schedule) throw Error("no tick schedule");
    const price = roundToTick((inst.last || inst.bid) * 0.7, schedule);
    const { events, form } = renderTicket({
      ric,
      account: ACCOUNT,
      side: Side.Buy,
      ordType: OrdType.Limit,
      quantity: inst.lotSize,
      price,
    });
    await waitForInstrument();
    await waitFor(() =>
      expect(form.querySelector('[data-warning="collar"]')).not.toBeNull(),
    );
    await act(async () => {
      fireEvent.keyDown(form, { key: "Enter", ctrlKey: true });
    });
    await waitFor(() => {
      const status = form.querySelector('[data-status="REJECTED"]');
      expect(status?.getAttribute("data-reason")).toBe("PRICE_OUTSIDE_COLLAR");
    });
    expect(
      events.some(
        (e) => e.kind === "reject" && e.reason === "PRICE_OUTSIDE_COLLAR",
      ),
    ).toBe(true);
  });

  test("keyboard: B/S switch side, arrows nudge, Esc resets then closes", async () => {
    const inst = instrumentRow();
    const { form, closed } = renderTicket({
      ric,
      account: ACCOUNT,
      side: Side.Buy,
      ordType: OrdType.Limit,
      quantity: inst.lotSize,
      price: inst.bid,
    });
    await waitForInstrument();
    act(() => {
      fireEvent.keyDown(form, { key: "s" });
    });
    expect(form.getAttribute("data-side")).toBe(Side.Sell);
    act(() => {
      fireEvent.keyDown(form, { key: "b" });
    });
    expect(form.getAttribute("data-side")).toBe(Side.Buy);

    const qty = form.querySelector(
      'input[data-order-ticket-field="quantity"]',
    ) as HTMLInputElement;
    act(() => {
      fireEvent.keyDown(qty, { key: "ArrowUp" });
    });
    expect(qty.value).toBe(String(inst.lotSize * 2));
    // typing "s" in the quantity field switches side, it is not text
    act(() => {
      fireEvent.keyDown(qty, { key: "s" });
    });
    expect(form.getAttribute("data-side")).toBe(Side.Sell);

    const price = form.querySelector(
      'input[data-order-ticket-field="price"]',
    ) as HTMLInputElement;
    const before = Number(price.value);
    act(() => {
      fireEvent.keyDown(price, { key: "ArrowDown" });
    });
    expect(Number(price.value)).toBeLessThan(before);

    act(() => {
      fireEvent.keyDown(form, { key: "Escape" });
    });
    expect(form.getAttribute("data-side")).toBe(Side.Buy);
    expect(qty.value).toBe(String(inst.lotSize));
    expect(closed).toHaveLength(0);
    act(() => {
      fireEvent.keyDown(form, { key: "Escape" });
    });
    expect(closed).toHaveLength(1);
  });
});
