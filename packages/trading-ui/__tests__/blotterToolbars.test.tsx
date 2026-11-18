import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  createTradingTestData,
  setCurrentUser,
} from "@heswell/trading-test-data";
import { createTradingLocalServer } from "@heswell/trading-test-data/react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { FillsBlotter, OrderBlotter, TradingDataProvider } from "../src";

afterEach(cleanup);

describe("blotter toolbars", () => {
  setCurrentUser({ name: "admin", authorizations: [] });
  const testData = createTradingTestData({
    seed: 21,
    exchange: { activeInstruments: 5 },
    oms: { flowRate: 0 },
    manualClock: true,
  });
  const localServer = createTradingLocalServer(testData, "toolbar-test");
  afterAll(() => testData.dispose());

  const Wrapper = ({ children }: { children: ReactNode }) => (
    <TradingDataProvider mode="local" localServer={localServer}>
      {children}
    </TradingDataProvider>
  );

  const pressed = (name: string) =>
    screen.getByRole("radio", { name }).getAttribute("aria-checked");

  test("order status is a toggle group: Working, Filled, Closed, All", () => {
    render(<OrderBlotter />, { wrapper: Wrapper });
    const group = screen.getByRole("radiogroup", { name: "Order status" });
    const labels = [...group.querySelectorAll("button")].map(
      (b) => b.textContent,
    );
    expect(labels).toEqual(["Working", "Filled", "Closed", "All"]);
    expect(
      screen.getByRole("radio", { name: "Closed" }).getAttribute("title"),
    ).toBe("Cancelled, rejected or expired");
    expect(pressed("Working")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: "Closed" }));
    expect(pressed("Closed")).toBe("true");
    expect(pressed("Working")).toBe("false");
  });

  test("order actions are Salt buttons with full accessible names", () => {
    render(<OrderBlotter />, { wrapper: Wrapper });
    expect(
      screen.getByRole("button", { name: "Show order book" }),
    ).toBeTruthy();
    const cancelSelected = screen.getByRole("button", {
      name: "Cancel selected (0)",
    }) as HTMLButtonElement;
    expect(cancelSelected.disabled).toBe(true);
    expect(cancelSelected.className).toContain("saltButton");
    expect(screen.getByRole("button", { name: "Cancel all" })).toBeTruthy();
  });

  test("fills Group by is a toggle group", () => {
    render(<FillsBlotter />, { wrapper: Wrapper });
    expect(screen.getByRole("radiogroup", { name: "Group by" })).toBeTruthy();
    expect(pressed("None")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: "RIC / side" }));
    expect(pressed("RIC / side")).toBe("true");
    expect(
      screen.getByRole("button", { name: /^Export CSV \(\d+\)$/ }),
    ).toBeTruthy();
  });
});
