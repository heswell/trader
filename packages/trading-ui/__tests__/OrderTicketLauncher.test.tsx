import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  createTradingTestData,
  setCurrentUser,
} from "@heswell/trading-test-data";
import { createTradingLocalServer } from "@heswell/trading-test-data/react";
import { Side } from "@heswell/trading-schemas";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import {
  ConnectionBanner,
  type OrderTicketLauncher,
  OrderTicketLauncherProvider,
  OrderTicketPanel,
  StaleIndicator,
  TradingDataProvider,
  useOrderTicketLauncher,
} from "../src";

setCurrentUser({ name: "admin", authorizations: [] });
const td = createTradingTestData({
  seed: 5,
  exchange: { activeInstruments: 3 },
  oms: { flowRate: 0 },
  manualClock: true,
});
const localServer = createTradingLocalServer(td, "launcher-test");

afterEach(cleanup);
afterAll(() => td.dispose());

let launcher: OrderTicketLauncher;
const Grab = () => {
  const l = useOrderTicketLauncher();
  useEffect(() => {
    launcher = l;
  }, [l]);
  return null;
};

describe("OrderTicketLauncher", () => {
  test("without a provider openOrderTicket is a no-op", () => {
    render(<Grab />);
    expect(launcher.available).toBe(false);
    expect(() => launcher.openOrderTicket({ ric: "VOD.L" })).not.toThrow();
  });

  test("opens a dialog with the prefill when no panel is docked", () => {
    render(
      <TradingDataProvider localServer={localServer} mode="local">
        <OrderTicketLauncherProvider dialogProps={{ followSelection: false }}>
          <Grab />
        </OrderTicketLauncherProvider>
      </TradingDataProvider>,
    );
    expect(launcher.available).toBe(true);
    act(() =>
      launcher.openOrderTicket({
        ric: "VOD.L",
        side: Side.Sell,
        quantity: 500,
      }),
    );
    const form = screen.getByRole("form");
    expect(form.getAttribute("data-side")).toBe(Side.Sell);
    expect(screen.getByRole("dialog")).toBeTruthy();
    act(() => launcher.closeOrderTicket());
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("routes prefills to a docked OrderTicketPanel", () => {
    render(
      <TradingDataProvider localServer={localServer} mode="local">
        <OrderTicketLauncherProvider>
          <Grab />
          <OrderTicketPanel
            followSelection={false}
            showInstrumentPicker={false}
          />
        </OrderTicketLauncherProvider>
      </TradingDataProvider>,
    );
    const form = screen.getByRole("form");
    expect(form.getAttribute("data-side")).toBe(Side.Buy);
    act(() => launcher.openOrderTicket({ ric: "VOD.L", side: Side.Sell }));
    expect(form.getAttribute("data-side")).toBe(Side.Sell);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      form.querySelector('[data-field="ric"]')?.textContent ?? "",
    ).toContain("VOD.L");
  });
});

describe("ConnectionBanner / StaleIndicator", () => {
  test("banner renders nothing when connected and an alert otherwise", () => {
    const { rerender, container } = render(
      <ConnectionBanner state="connected" />,
    );
    expect(container.textContent).toBe("");
    rerender(<ConnectionBanner state="reconnecting" />);
    const alert = screen.getByRole("alert");
    expect(
      alert
        .closest("[data-connection-state]")
        ?.getAttribute("data-connection-state") ??
        alert.getAttribute("data-connection-state"),
    ).toBe("reconnecting");
  });

  test("stale indicator shows a reason", () => {
    render(<StaleIndicator reason="noUpdates" />);
    expect(screen.getByRole("status").getAttribute("data-stale-reason")).toBe(
      "noUpdates",
    );
  });
});
