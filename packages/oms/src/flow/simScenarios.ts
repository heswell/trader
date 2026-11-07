import type {
  ExchangeSimulator,
  ScenarioDef,
  ScenarioRun,
  StepAction,
} from "@heswell/exchange-sim/engine";
import {
  type AlgoStrategy,
  ClientPersona,
  type Side,
} from "@heswell/trading-schemas";
import type { OmsService } from "../engine/OmsService";
import type { BackgroundFlow } from "./BackgroundFlow";
import type { ClientBotSelector, ClientBotSnapshot } from "./ClientFlow";

/** Scenarios that use the OMS actions (defined by connectClientFlowToSim). */
const scenarios: ScenarioDef[] = [
  {
    name: "client-liquidation",
    description:
      "A client sells $usd of one name with an urgent POV ($pct% of volume, market parent).",
    targets: { random: 1 },
    args: { usd: 1_800_000, pct: 25 },
    steps: [
      {
        at: "+0s",
        action: "submitClientAlgo",
        params: {
          persona: ClientPersona.Liquidation,
          side: "SELL",
          notionalUsd: "$usd",
          strategy: "POV",
          participationPct: "$pct",
          durationMins: 20,
          limitBps: 0,
        },
      },
      { at: "+10m", action: "revert" },
    ],
  },
  {
    name: "pension-programme",
    description:
      "A pension fund works a one-sided ($side) programme of VWAPs across the targets.",
    targets: { random: 5 },
    args: { side: "BUY", perMin: 3 },
    steps: [
      {
        at: "+0s",
        action: "addClientBot",
        params: {
          persona: ClientPersona.Pension,
          programmeSide: "$side",
          ordersPerMin: "$perMin",
        },
      },
      { at: "+15m", action: "revert" },
    ],
  },
  {
    name: "informed-client-news",
    description:
      "Lagging makers, then a $bps bp news jump traded first by an informed client's POV.",
    targets: { random: 1 },
    args: { bps: 100 },
    steps: [
      {
        at: "+0s",
        action: "setBotParams",
        params: { kind: "marketMaker", fairHalfLifeSecs: 20 },
      },
      {
        at: "+0s",
        action: "addClientBot",
        params: { persona: ClientPersona.Informed, ordersPerMin: 30 },
      },
      { at: "+2s", action: "shiftFairValue", params: { bps: "$bps" } },
      { at: "+2m", action: "revert" },
    ],
  },
];
export const CLIENT_SCENARIOS: readonly ScenarioDef[] =
  Object.freeze(scenarios);

/** What a run changed on the OMS side, to undo on revert. */
interface RunChanges {
  added: Set<string>;
  bots: Map<string, ClientBotSnapshot>;
  flow?: BackgroundFlow["params"];
}

const selectorOf = (p: Record<string, unknown>): ClientBotSelector => ({
  ...(p.botId ? { botId: String(p.botId) } : {}),
  ...(p.persona ? { persona: String(p.persona) } : {}),
});

const optionalNumber = (value: unknown) =>
  value === undefined || value === "" ? undefined : Number(value);

/**
 * Connect the OMS client bots to an exchange simulator in the same process:
 * informed bots see its fair value and `sector:` universes its sectors,
 * client bot changes are logged in simEvents, and the OMS actions
 * (addClientBot, setClientBotParams, pauseClientBots, resumeClientBots,
 * submitClientAlgo, setFlowParams) become scenario steps, undone by a
 * run's revert. Then CLIENT_SCENARIOS are defined. Call it before the
 * EXCHANGE tables are attached so the scenarios table lists them.
 */
export const connectClientFlowToSim = (
  oms: OmsService,
  sim: ExchangeSimulator,
) => {
  const { clients, flow } = oms;
  clients.market = {
    fairValue: (ric) =>
      sim.isSimulated(ric)
        ? sim.instrumentsFor(ric)[0]?.book.model.fairValue
        : undefined,
    sectorOf: (ric) => sim.getInstrument(ric)?.sector,
  };
  const offEvents = clients.onEvent(({ action, target, details, ctx }) =>
    sim.control.record(action, target, details, ctx),
  );

  const changes = new Map<string, RunChanges>();
  const changesOf = (run: ScenarioRun) => {
    let c = changes.get(run.runId);
    if (!c) {
      c = { added: new Set(), bots: new Map() };
      changes.set(run.runId, c);
    }
    return c;
  };
  /** Remember the selected bots' settings before a run first changes them. */
  const save = (run: ScenarioRun, selector: ClientBotSelector) => {
    const c = changesOf(run);
    for (const bot of clients.select(selector))
      if (!c.added.has(bot.id) && !c.bots.has(bot.id))
        c.bots.set(bot.id, clients.snapshot(bot));
  };
  const add = (
    run: ScenarioRun,
    persona: string,
    params: Record<string, unknown>,
    account?: string,
  ) => {
    // trade the run's instruments unless told otherwise ("all" = everything)
    const universe =
      params.universe === undefined
        ? run.targets.join(",")
        : params.universe === "all"
          ? ""
          : String(params.universe);
    const bot = clients.add(
      persona,
      { account, params: { ...params, universe } },
      { runId: run.runId },
    );
    changesOf(run).added.add(bot.id);
    return bot;
  };

  const actions: Record<string, StepAction> = {
    addClientBot: (_runner, run, p) => {
      const { persona, count = 1, account, ...params } = p;
      for (let i = 0; i < Number(count); i++)
        add(
          run,
          String(persona),
          params,
          account ? String(account) : undefined,
        );
    },
    setClientBotParams: (_runner, run, p) => {
      const { botId, persona, ...values } = p;
      const selector = selectorOf({ botId, persona });
      save(run, selector);
      for (const [name, value] of Object.entries(values))
        clients.setParams(selector, name, String(value), { runId: run.runId });
    },
    pauseClientBots: (_runner, run, p) => {
      save(run, selectorOf(p));
      clients.setPaused(selectorOf(p), true, { runId: run.runId });
    },
    resumeClientBots: (_runner, run, p) => {
      save(run, selectorOf(p));
      clients.setPaused(selectorOf(p), false, { runId: run.runId });
    },
    submitClientAlgo: (_runner, run, p) => {
      const rics = p.ric ? [String(p.ric)] : run.targets;
      let botId = p.botId ? String(p.botId) : undefined;
      if (!botId) {
        const persona = String(p.persona ?? ClientPersona.Quant);
        botId =
          clients.select({ persona })[0]?.id ??
          add(run, persona, { ordersPerMin: 0 }).id;
      }
      for (const ric of rics)
        clients.submit(
          botId,
          {
            ric,
            side: p.side ? (String(p.side) as Side) : undefined,
            notionalUsd: optionalNumber(p.notionalUsd),
            quantity: optionalNumber(p.quantity),
            strategy: p.strategy
              ? (String(p.strategy) as AlgoStrategy)
              : undefined,
            durationMins: optionalNumber(p.durationMins),
            participationPct: optionalNumber(p.participationPct),
            limitBps: optionalNumber(p.limitBps),
          },
          { runId: run.runId },
        );
    },
    setFlowParams: (_runner, run, p) => {
      const c = changesOf(run);
      c.flow ??= flow.params;
      const params = {
        rate: optionalNumber(p.rate),
        notionalUsd: optionalNumber(p.notionalUsd),
        maxWorking: optionalNumber(p.maxWorking),
        cancelRate: optionalNumber(p.cancelRate),
      };
      flow.setParams(params);
      clients.recordFlowChange(params, { runId: run.runId });
    },
  };
  for (const [name, action] of Object.entries(actions))
    sim.scenarios.registerAction(name, action);

  const offRevert = sim.scenarios.onRevert((run) => {
    const c = changes.get(run.runId);
    if (!c) return;
    changes.delete(run.runId);
    for (const botId of c.added)
      if (clients.getBot(botId)) clients.remove(botId, { runId: run.runId });
    for (const snapshot of c.bots.values()) clients.restore(snapshot);
    if (c.flow) flow.setParams(c.flow);
  });

  sim.scenarios.define(...CLIENT_SCENARIOS);
  return () => {
    offEvents();
    offRevert();
    clients.market = {};
  };
};
