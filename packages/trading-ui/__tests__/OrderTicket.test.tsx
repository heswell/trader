import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  createTradingTestData,
  setCurrentUser,
} from "@heswell/trading-test-data";
import { createTradingLocalServer } from "@heswell/trading-test-data/react";
import {
  AlgoStrategy,
  OrdStatus,
  OrdType,
  roundToTick,
  Side,
  stepTicks,
  TimeInForce,
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
    ask: get("ask") as number,
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

  test("a price outside the collar is an error on the price before sending", async () => {
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
    // The OMS reports the breach in the row's vuuMsg: shown on the price,
    // and the order is not sent.
    await waitFor(() =>
      expect(
        form
          .querySelector('input[data-order-ticket-field="price"]')
          ?.getAttribute("aria-invalid"),
      ).toBe("true"),
    );
    expect(form.querySelector('[role="dialog"]')).toBeNull();
    expect(events).toHaveLength(0);
  });

  test("a typed field is committed on Enter and checked by the OMS", async () => {
    const inst = instrumentRow();
    const schedule = scheduleOf(inst);
    if (!schedule) throw Error("no tick schedule");
    const onTick = roundToTick(inst.bid, schedule);
    const tick = stepTicks(onTick, schedule, 1) - onTick;
    const { events, form } = renderTicket({
      ric,
      account: ACCOUNT,
      side: Side.Buy,
      ordType: OrdType.Limit,
      quantity: inst.lotSize,
    });
    await waitForInstrument();
    const price = form.querySelector(
      'input[data-order-ticket-field="price"]',
    ) as HTMLInputElement;
    act(() => {
      fireEvent.change(price, {
        target: { value: String(onTick + tick / 2) },
      });
    });
    // Not checked while it is being typed ...
    expect(price.getAttribute("aria-invalid")).not.toBe("true");
    act(() => {
      fireEvent.keyDown(price, { key: "Enter" });
    });
    // ... the OMS checks it once committed (editCell), reported in vuuMsg.
    await waitFor(() =>
      expect(form.textContent).toContain("is not on a valid tick"),
    );
    expect(events).toHaveLength(0);
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

  test("an order line in the instrument field fills the ticket", async () => {
    const inst = instrumentRow();
    const { form, events } = renderTicket({
      ric,
      account: ACCOUNT,
      side: Side.Buy,
      ordType: OrdType.Limit,
      timeInForce: TimeInForce.ImmediateOrCancel,
      quantity: inst.lotSize,
      price: inst.bid,
    });
    await waitForInstrument();
    const field = form.querySelector(
      'input[data-order-ticket-field="instrument"]',
    ) as HTMLInputElement;
    act(() => {
      fireEvent.change(field, { target: { value: "s 2k b twap 45m" } });
    });
    await waitFor(() =>
      expect(
        form.querySelector(".tradingOrderTicket-orderLine"),
      ).not.toBeNull(),
    );
    act(() => {
      fireEvent.keyDown(field, { key: "Enter" });
    });
    expect(form.getAttribute("data-side")).toBe(Side.Sell);
    const qty = form.querySelector(
      'input[data-order-ticket-field="quantity"]',
    ) as HTMLInputElement;
    expect(qty.value).toBe("2k");
    const duration = form.querySelector(
      'input[data-order-ticket-field="param:durationMins"]',
    ) as HTMLInputElement;
    expect(duration.value).toBe("45m");
    // IOC is not valid for TWAP: the ticket moves to Day and says so.
    expect(form.querySelector(".tradingOrderTicket-tifNotice")).not.toBeNull();
    expect(
      form.querySelector(".tradingOrderTicket-submitDetail")?.textContent,
    ).toContain("Day");
    // It keeps the instrument and does not send.
    expect(field.value).toBe(ric);
    expect(events).toHaveLength(0);
  });

  test("Enter moves on and selects the next field, so typing replaces it", async () => {
    const inst = instrumentRow();
    const { form } = renderTicket({
      ric,
      account: ACCOUNT,
      side: Side.Buy,
      ordType: OrdType.Limit,
      quantity: inst.lotSize,
      price: inst.bid,
    });
    await waitForInstrument();
    const qty = form.querySelector(
      'input[data-order-ticket-field="quantity"]',
    ) as HTMLInputElement;
    const price = form.querySelector(
      'input[data-order-ticket-field="price"]',
    ) as HTMLInputElement;
    qty.focus();
    act(() => {
      fireEvent.keyDown(qty, { key: "Enter" });
    });
    expect(document.activeElement).toBe(price);
    expect(price.selectionStart).toBe(0);
    expect(price.selectionEnd).toBe(price.value.length);
    // Enter resolves shorthand from the field's own text.
    act(() => {
      fireEvent.change(price, { target: { value: "b" } });
      fireEvent.keyDown(price, { key: "Enter" });
    });
    expect(Number(price.value)).toBe(inst.bid);
  });

  test("Alt shortcuts set type and side from any field", async () => {
    const inst = instrumentRow();
    const { form } = renderTicket({
      ric,
      account: ACCOUNT,
      side: Side.Buy,
      ordType: OrdType.Limit,
      quantity: inst.lotSize,
      price: inst.bid,
    });
    await waitForInstrument();
    const price = form.querySelector(
      'input[data-order-ticket-field="price"]',
    ) as HTMLInputElement;
    act(() => {
      fireEvent.keyDown(price, { key: "ß", code: "KeyS", altKey: true });
    });
    expect(form.getAttribute("data-side")).toBe(Side.Sell);
    act(() => {
      fireEvent.keyDown(price, { key: "µ", code: "KeyM", altKey: true });
    });
    expect(
      form.querySelector('input[data-order-ticket-field="price"]'),
    ).toBeNull();
    expect(form.querySelector('[data-field="marketPrice"]')).not.toBeNull();
    act(() => {
      fireEvent.keyDown(form, { key: "¬", code: "KeyL", altKey: true });
    });
    expect(
      form.querySelector('input[data-order-ticket-field="price"]'),
    ).not.toBeNull();
  });

  test("a quantity over the account limit is an error on the quantity", async () => {
    const inst = instrumentRow();
    const { events, form } = renderTicket({
      ric,
      account: ACCOUNT,
      side: Side.Buy,
      ordType: OrdType.Limit,
      quantity: inst.lotSize * 1_000_000,
      price: inst.bid,
    });
    await waitForInstrument();
    await act(async () => {
      fireEvent.keyDown(form, { key: "F9" });
    });
    await waitFor(() =>
      expect(
        form
          .querySelector('input[data-order-ticket-field="quantity"]')
          ?.getAttribute("aria-invalid"),
      ).toBe("true"),
    );
    expect(events).toHaveLength(0);
  });

  test("stops by keyboard: Alt+P / Alt+Shift+P, stop field after quantity", async () => {
    const inst = instrumentRow();
    const schedule = scheduleOf(inst);
    if (!schedule) throw Error("no tick schedule");
    const { form, events } = renderTicket({
      ric,
      account: ACCOUNT,
      side: Side.Buy,
      ordType: OrdType.Limit,
      quantity: inst.lotSize,
      price: inst.bid,
    });
    await waitForInstrument();
    const field = (name: string) =>
      form.querySelector(
        `input[data-order-ticket-field="${name}"]`,
      ) as HTMLInputElement | null;
    const qty = field("quantity") as HTMLInputElement;
    act(() => {
      fireEvent.keyDown(qty, { key: "π", code: "KeyP", altKey: true });
    });
    expect(
      form
        .querySelector('[data-ord-type="STOP"]')
        ?.getAttribute("aria-checked"),
    ).toBe("true");
    // STOP: a stop price, no limit (market on trigger).
    expect(field("price")).toBeNull();
    expect(form.querySelector('[data-field="marketPrice"]')).not.toBeNull();
    const stop = field("stopPrice") as HTMLInputElement;
    expect(stop).not.toBeNull();
    // Tab / Enter order: quantity → stop price.
    qty.focus();
    act(() => {
      fireEvent.keyDown(qty, { key: "Enter" });
    });
    expect(document.activeElement).toBe(stop);
    // Arrows start an empty stop one tick beyond the market (above, a buy).
    act(() => {
      fireEvent.keyDown(stop, { key: "ArrowUp" });
    });
    const market = inst.last;
    expect(Number(stop.value)).toBe(
      stepTicks(roundToTick(market, schedule), schedule, 1),
    );
    act(() => {
      fireEvent.keyDown(stop, { key: "ArrowUp" });
    });
    expect(Number(stop.value)).toBe(
      stepTicks(roundToTick(market, schedule), schedule, 2),
    );
    expect(submitButton().textContent).toContain(" Stop ");

    // Shift: STOP_LIMIT keeps the stop and adds the limit after it.
    act(() => {
      fireEvent.keyDown(stop, {
        key: "∏",
        code: "KeyP",
        altKey: true,
        shiftKey: true,
      });
    });
    const limit = field("price") as HTMLInputElement;
    expect(limit).not.toBeNull();
    expect(field("stopPrice")?.value).toBe(stop.value);
    act(() => {
      fireEvent.keyDown(stop, { key: "Enter" });
    });
    expect(document.activeElement).toBe(limit);
    act(() => {
      fireEvent.change(limit, { target: { value: stop.value } });
    });
    expect(submitButton().textContent).toMatch(/Stop [\d.,]+ Limit [\d.,]+/);

    // Back to Limit: the stop price goes.
    act(() => {
      fireEvent.keyDown(form, { key: "¬", code: "KeyL", altKey: true });
    });
    expect(field("stopPrice")).toBeNull();
    act(() => {
      fireEvent.keyDown(form, { key: "π", code: "KeyP", altKey: true });
    });
    expect(field("stopPrice")?.value).toBe("");
    expect(events).toHaveLength(0);
  });

  test("a stop already reached is an error before sending", async () => {
    const inst = instrumentRow();
    const schedule = scheduleOf(inst);
    if (!schedule) throw Error("no tick schedule");
    const { form, events } = renderTicket({
      ric,
      account: ACCOUNT,
      side: Side.Buy,
      ordType: OrdType.Stop,
      quantity: inst.lotSize,
      stopPrice: stepTicks(roundToTick(inst.last, schedule), schedule, -2),
    });
    await waitForInstrument();
    act(() => {
      fireEvent.keyDown(form, { key: "F9" });
    });
    await waitFor(() =>
      expect(form.textContent).toContain("must be above the market price"),
    );
    expect(
      form
        .querySelector('input[data-order-ticket-field="stopPrice"]')
        ?.getAttribute("aria-invalid"),
    ).toBe("true");
    expect(events).toHaveLength(0);
  });

  test("stops are DMA only: picking one switches an algo order to DMA", async () => {
    const inst = instrumentRow();
    const { form } = renderTicket({
      ric,
      account: ACCOUNT,
      side: Side.Sell,
      ordType: OrdType.Limit,
      strategy: AlgoStrategy.Twap,
      quantity: inst.lotSize,
      price: inst.bid,
    });
    await waitForInstrument();
    act(() => {
      fireEvent.keyDown(form, { key: "π", code: "KeyP", altKey: true });
    });
    expect(
      form
        .querySelector(".tradingOrderTicket-execution")
        ?.getAttribute("data-strategy"),
    ).toBe(AlgoStrategy.Dma);
    expect(form.textContent).toContain("Stops are DMA only");
    // TIF choices for a stop: Day and GTC only.
    act(() => {
      fireEvent.keyDown(form, { key: "†", code: "KeyT", altKey: true });
    });
    expect(
      form.querySelector(".tradingOrderTicket-submitDetail")?.textContent,
    ).toContain("GTC");
    act(() => {
      fireEvent.keyDown(form, { key: "†", code: "KeyT", altKey: true });
    });
    expect(
      form.querySelector(".tradingOrderTicket-submitDetail")?.textContent,
    ).toContain("Day");
  });

  test("submits a stop with stopPrice; it waits until triggered", async () => {
    const inst = instrumentRow();
    const schedule = scheduleOf(inst);
    if (!schedule) throw Error("no tick schedule");
    const stopPrice = roundToTick(inst.last * 1.05, schedule);
    const { form, events } = renderTicket({
      ric,
      account: ACCOUNT,
      side: Side.Buy,
      ordType: OrdType.Stop,
      quantity: inst.lotSize,
      stopPrice,
    });
    await waitForInstrument();
    await waitFor(() => expect(submitButton().textContent).toContain("Stop"));
    await act(async () => {
      fireEvent.keyDown(form, { key: "F9" });
    });
    await waitFor(() => expect(events.length).toBeGreaterThan(0));
    await waitFor(() =>
      expect(
        form.querySelector(".tradingOrderTicket-status")?.textContent,
      ).toContain("Waiting for stop"),
    );
    const orders = td.oms.getTable("parentOrders");
    const row = orders.data.find(
      (r) => r[orders.map.clOrdId] === events[0].clOrdId,
    );
    expect(row?.[orders.map.ordType]).toBe(OrdType.Stop);
    expect(row?.[orders.map.stopPrice]).toBe(stopPrice);
    expect(row?.[orders.map.price] || 0).toBe(0);
  });
});
