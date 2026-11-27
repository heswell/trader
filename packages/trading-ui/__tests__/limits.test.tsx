import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { BreachStatus, LimitState } from "@heswell/trading-schemas";
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
  within,
} from "@testing-library/react";
import {
  expiryTime,
  formatLimitAmount,
  LimitBreaches,
  LimitMonitor,
  limitLabel,
  TradingDataProvider,
  UtilisationBar,
} from "../src";

setCurrentUser({ name: "admin", authorizations: [] });
const testData = createTradingTestData({
  seed: 3,
  exchange: { activeInstruments: 3 },
  oms: { flowRate: 0, limits: "ACC-US-01:ORDER_QTY=100" },
  manualClock: true,
});
const localServer = createTradingLocalServer(testData, "limits");
const { omsService } = testData;

// a 90 lot order uses 90% of ACC-US-01's 100 lot limit: a warning breach
const ric = testData.sim.books[0].ric;
const created = testData.rpc("createOrder", {
  account: "ACC-US-01",
  ric,
  side: "BUY",
  ordType: "MARKET",
  quantity: 90,
});
if (created.type !== "SUCCESS_RESULT") {
  throw Error(`createOrder: ${JSON.stringify(created)}`);
}
omsService.updateLimitUtilisation();

afterEach(cleanup);
afterAll(() => testData.dispose());

const wrap = (node: React.ReactNode) => (
  <TradingDataProvider localServer={localServer} mode="local">
    {node}
  </TradingDataProvider>
);

describe("limit formatting", () => {
  test("amounts, labels and expiry times", () => {
    expect(formatLimitAmount(1_250_000)).toBe("1.25m");
    expect(formatLimitAmount(400_000)).toBe("400k");
    expect(limitLabel("POSITION_NOTIONAL", "BARC.L")).toBe(
      "Position notional · BARC.L",
    );
    const monday = new Date(2026, 10, 23, 14, 30);
    expect(new Date(expiryTime("day", monday)).getHours()).toBe(22);
    expect(new Date(expiryTime("week", monday)).getDay()).toBe(5);
    // after 22:00, end of day is tomorrow's
    const late = new Date(2026, 10, 23, 23, 0);
    expect(new Date(expiryTime("day", late)).getDate()).toBe(24);
  });

  test("the utilisation bar is a meter with ticks at warning, limit and hard", () => {
    render(
      <UtilisationBar
        hardPct={1.1}
        state={LimitState.Warning}
        utilisation={0.9}
        warningPct={0.8}
      />,
    );
    const meter = screen.getByRole("img", { name: "Utilisation 90%" });
    expect(meter.querySelectorAll(".tradingUtilisationBar-tick")).toHaveLength(
      3,
    );
  });
});

describe("LimitMonitor", () => {
  test("counts limits by state and lists them by desk and entity", async () => {
    render(wrap(<LimitMonitor />));
    const counts = screen.getByTestId("limit-state-counts");
    await waitFor(() =>
      expect(
        within(counts).getByText("Warning").parentElement?.textContent,
      ).toBe("Warning1"),
    );
    expect(within(counts).getByText("OK").parentElement?.textContent).toMatch(
      /^OK[1-9]\d*$/,
    );
  });
});

describe("LimitBreaches", () => {
  test("lists the open breach and acknowledges it from the detail pane", async () => {
    render(wrap(<LimitBreaches defaultBreachId="B-1" />));
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: /^Open/ }).textContent).toBe(
        "Open 1",
      ),
    );
    const detail = await screen.findByTestId("limit-breach-detail");
    expect(within(detail).getByRole("heading").textContent).toContain(
      "Order quantity · ACC-US-01",
    );
    await waitFor(() =>
      expect(
        within(detail).getByTestId("breach-timeline").textContent,
      ).toContain("Crossed warning"),
    );
    await act(async () => {
      fireEvent.click(
        within(detail).getByRole("button", { name: "Acknowledge" }),
      );
    });
    await waitFor(() =>
      expect(omsService.limitMonitor.breaches.get("B-1")?.status).toBe(
        BreachStatus.Acknowledged,
      ),
    );
  });
});
