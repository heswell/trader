import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  createTradingTestData,
  setCurrentUser,
} from "@heswell/trading-test-data";
import { createTradingLocalServer } from "@heswell/trading-test-data/react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  BotDetail,
  ScenarioRuns,
  SimEventsLog,
  SimInstrumentControls,
  SimSessionStrip,
  TradingDataProvider,
} from "../src";

setCurrentUser({ name: "admin", authorizations: [] });
const testData = createTradingTestData({
  seed: 5,
  exchange: { activeInstruments: 2 },
  oms: { flowRate: 0 },
  manualClock: true,
});
const localServer = createTradingLocalServer(testData, "simulator-controls");
const { sim } = testData;

afterEach(cleanup);
afterAll(() => testData.dispose());

const wrap = (children: React.ReactNode) => (
  <TradingDataProvider mode="local" localServer={localServer}>
    {children}
  </TradingDataProvider>
);

const ric = () => sim.books[0].ric;

describe("simulator controls", () => {
  test("SimSessionStrip shows the phase; Pause all bots pauses every bot", async () => {
    render(wrap(<SimSessionStrip />));
    await waitFor(() =>
      expect(screen.getByTestId("trading-sim-phase").textContent).toBe(
        sim.marketPhase,
      ),
    );
    fireEvent.click(screen.getByText("Pause all bots"));
    await waitFor(() =>
      expect(screen.getByText("All bots paused")).toBeTruthy(),
    );
    expect(sim.getBots().every((bot) => bot.port.paused)).toBe(true);
    fireEvent.click(screen.getByText("Resume all bots"));
    await waitFor(() =>
      expect(screen.getByText("All bots resumed")).toBeTruthy(),
    );
    expect(sim.getBots().some((bot) => bot.port.paused)).toBe(false);
  });

  test("ScenarioRuns lists a run; Stop and revert ends it", async () => {
    const run = sim.scenarios.run("volatile-open", { rics: [ric()] });
    render(wrap(<ScenarioRuns />));
    await waitFor(() => expect(screen.getByText(run.runId)).toBeTruthy());
    fireEvent.click(screen.getByText("Stop and revert"));
    await waitFor(() => expect(run.status).toBe("STOPPED"));
    expect(run.reverted).toBe(true);
  });

  test("SimInstrumentControls jumps fair value and sets drift", async () => {
    render(wrap(<SimInstrumentControls ric={ric()} />));
    await waitFor(() => expect(screen.getByText("Price model")).toBeTruthy());
    const model = sim.getBook(ric())?.model;
    const walk = Number(model?.walk);
    fireEvent.click(screen.getByText("+25 bp"));
    await waitFor(() =>
      expect(Number(model?.walk) / walk).toBeCloseTo(1.0025, 6),
    );
    fireEvent.change(screen.getByLabelText("Drift"), {
      target: { value: "120" },
    });
    fireEvent.click(screen.getByText("Apply"));
    await waitFor(() => expect(model?.driftBpsPerHour).toBe(120));
    sim.control.setInstrumentParams(ric(), { driftBpsPerHour: 0 });
  });

  test("BotDetail edits a parameter and marks it changed", async () => {
    const bot = sim.getBots(ric()).find((b) => b.kind === "marketMaker");
    if (!bot) throw Error("no market maker");
    render(wrap(<BotDetail botId={bot.id} />));
    const input = (await screen.findByLabelText("levels")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "2" } });
    fireEvent.click(screen.getByText("Set"));
    await waitFor(() => expect(bot.params.levels).toBe(2));
    sim.flush(sim.clock() + sim.config.simPublishIntervalMs);
    await waitFor(() =>
      expect(screen.getAllByTestId("trading-bot-param-changed").length).toBe(1),
    );
    fireEvent.click(screen.getByText("Reset"));
    await waitFor(() =>
      expect(screen.queryAllByTestId("trading-bot-param-changed").length).toBe(
        0,
      ),
    );
  });

  test("SimEventsLog renders", () => {
    render(wrap(<SimEventsLog />));
    expect(screen.getByTestId("trading-sim-events-log")).toBeTruthy();
  });
});
