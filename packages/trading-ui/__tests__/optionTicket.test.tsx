import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { PutCall } from "@heswell/trading-schemas";
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
import {
  InstrumentContextProvider,
  OrderTicket,
  TradingDataProvider,
} from "../src";

setCurrentUser({ name: "admin", authorizations: [] });
const td = createTradingTestData({
  seed: 11,
  exchange: { activeInstruments: 3, options: "AAPL.OQ" },
  oms: { flowRate: 0 },
  manualClock: true,
});
td.advance(2_000);
const localServer = createTradingLocalServer(td, "option-ticket-test");
const ACCOUNT = "ACC-US-01";

const chain = td.sim.optionChain("AAPL.OQ");
const front = Math.min(...chain.map((o) => o.expiry ?? Infinity));
const calls = chain
  .filter((o) => o.expiry === front && o.putCall === PutCall.Call)
  .sort((a, b) => (a.strike ?? 0) - (b.strike ?? 0));
const liquidCalls = calls.filter((o) => o.liquid);
const wing = calls[calls.length - 1];
const atm = liquidCalls[2];
if (!wing || !atm || wing.liquid) throw Error("unexpected chain");

afterEach(cleanup);
afterAll(() => td.dispose());

const renderTicket = (ric: string) => {
  render(
    <TradingDataProvider localServer={localServer} mode="local">
      <InstrumentContextProvider>
        <OrderTicket
          followSelection={false}
          prefill={{ ric, account: ACCOUNT }}
          rememberAccount={false}
        />
      </InstrumentContextProvider>
    </TradingDataProvider>,
  );
  const form = screen.getByRole("form");
  const field = form.querySelector(
    'input[data-order-ticket-field="instrument"]',
  ) as HTMLInputElement;
  return { form, field };
};

const terms = () =>
  document.querySelector('[data-field="optionTerms"]')?.textContent ?? "";

describe("OrderTicket on options", () => {
  test("shows the option's terms; Alt+↑ / ↓ step strikes", async () => {
    const { form, field } = renderTicket(atm.ric);
    await waitFor(() => expect(terms()).toContain(`Call ${atm.strike}`), {
      timeout: 3000,
    });
    expect(terms()).toContain("on AAPL.OQ");
    // implied vol and delta: the chain (and its analytics) has loaded
    await waitFor(
      () =>
        expect(
          document.querySelector('[data-field="impliedVol"]')?.textContent,
        ).toMatch(/IV \d+\.\d%/),
      { timeout: 3000 },
    );
    expect(document.querySelector('[data-field="delta"]')?.textContent).toMatch(
      /Δ 0\.\d\d/,
    );
    act(() => {
      fireEvent.keyDown(form, {
        key: "ArrowUp",
        code: "ArrowUp",
        altKey: true,
      });
    });
    const next = calls[calls.indexOf(atm) + 1];
    await waitFor(() => expect(field.value).toBe(next?.ric ?? ""));
    // Alt+C: the put on the same strike
    act(() => {
      fireEvent.keyDown(form, { key: "c", code: "KeyC", altKey: true });
    });
    await waitFor(() => expect(terms()).toContain(`Put ${next?.strike}`));
  });

  test("a quote-only strike points at the nearest liquid one", async () => {
    renderTicket(wing.ric);
    const button = await waitFor(
      () => screen.getByRole("button", { name: /^Trade the \d+ call$/ }),
      { timeout: 3000 },
    );
    expect(
      document.querySelector(".tradingOrderTicket-quoteOnly")?.textContent,
    ).toContain("Quote only");
    const nearest = liquidCalls[liquidCalls.length - 1];
    expect(button.textContent).toBe(`Trade the ${nearest?.strike} call`);
    act(() => {
      fireEvent.click(button);
    });
    await waitFor(() => expect(terms()).toContain(`Call ${nearest?.strike}`));
    expect(document.querySelector(".tradingOrderTicket-quoteOnly")).toBeNull();
  });

  test("an option typed as an order line is looked up in its chain", async () => {
    const { form, field } = renderTicket(atm.ric);
    await waitFor(() => expect(terms()).not.toBe(""), { timeout: 3000 });
    const strike = liquidCalls[0]?.strike;
    act(() => {
      fireEvent.change(field, { target: { value: `b 3 aapl ${strike}p` } });
    });
    await waitFor(() =>
      expect(
        form.querySelector(".tradingOrderTicket-orderLine"),
      ).not.toBeNull(),
    );
    act(() => {
      fireEvent.keyDown(field, { key: "Enter" });
    });
    await waitFor(() => expect(terms()).toContain(`Put ${strike}`));
    const qty = form.querySelector(
      'input[data-order-ticket-field="quantity"]',
    ) as HTMLInputElement;
    expect(qty.value).toBe("3");

    act(() => {
      fireEvent.change(field, { target: { value: "aapl 1c" } });
    });
    act(() => {
      fireEvent.keyDown(field, { key: "Enter" });
    });
    await waitFor(() =>
      expect(
        document.querySelector(".tradingOrderTicket-option[data-notice]")
          ?.textContent,
      ).toBe("No AAPL 1 call is listed"),
    );
  });
});
