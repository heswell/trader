import {
  scenarioRuns as scenarioRunsDef,
  scenarios as scenariosDef,
  simEvents as simEventsDef,
  simSession as simSessionDef,
} from "@heswell/trading-schemas";
import type {
  ScenarioDef,
  ScenarioRun,
} from "../engine/control/ScenarioRunner";
import { ScenarioStatus } from "../engine/control/ScenarioRunner";
import type { SimEvent } from "../engine/control/SimControl";
import type { ExchangeSimulator } from "../engine/ExchangeSimulator";
import { type PublishTable, RowLayout, type RowValue } from "./rows";

export interface ControlTables {
  simEvents?: PublishTable;
  scenarios?: PublishTable;
  scenarioRuns?: PublishTable;
  simSession?: PublishTable;
}

/** simEvents rows kept (oldest deleted). */
export const SIM_EVENTS_CAPACITY = 1_000;

const SESSION_KEY = "session";

const upsert = (table: PublishTable, key: string, row: RowValue[]) => {
  const rowIdx = table.rowIndexAtKey(key);
  if (rowIdx < 0) table.insert(row);
  else table.update(rowIdx, row);
};

const targetsLabel = (def: ScenarioDef) => {
  const t = def.targets ?? {};
  if (t.rics) return t.rics.join(",");
  if (t.sector) return `sector ${t.sector}`;
  if (t.random !== undefined) return `random ${t.random}`;
  return "all";
};

/**
 * Publishes the control tables (sim-admin only): the simEvents audit log,
 * scenario definitions and runs, and the session row. Events and runs are
 * published as they happen; the session row on each simulator publish.
 */
export class ControlPublisher {
  readonly #events?: {
    table: PublishTable;
    layout: RowLayout<typeof simEventsDef>;
  };
  readonly #runs?: {
    table: PublishTable;
    layout: RowLayout<typeof scenarioRunsDef>;
  };
  readonly #session?: {
    table: PublishTable;
    layout: RowLayout<typeof simSessionDef>;
  };
  readonly #eventKeys: string[] = [];
  readonly #unsubscribe: (() => void)[] = [];

  constructor(
    readonly sim: ExchangeSimulator,
    tables: ControlTables,
  ) {
    const { simEvents, scenarios, scenarioRuns, simSession } = tables;
    if (simEvents) {
      this.#events = {
        table: simEvents,
        layout: new RowLayout(simEvents, simEventsDef),
      };
      for (const event of sim.control.recent) this.#event(event);
      this.#unsubscribe.push(
        sim.control.onEvent((event) => this.#event(event)),
      );
    }
    if (scenarios) {
      const layout = new RowLayout(scenarios, scenariosDef);
      const { idx } = layout;
      for (const def of sim.scenarios.definitions) {
        const row = layout.row();
        row[idx.name] = def.name;
        row[idx.description] = def.description;
        row[idx.steps] = def.steps.length;
        row[idx.targets] = targetsLabel(def);
        row[idx.args] = JSON.stringify(def.args ?? {});
        upsert(scenarios, def.name, row);
      }
    }
    if (scenarioRuns) {
      this.#runs = {
        table: scenarioRuns,
        layout: new RowLayout(scenarioRuns, scenarioRunsDef, null),
      };
      for (const run of sim.scenarios.runs) this.#run(run);
      this.#unsubscribe.push(sim.scenarios.onChange((run) => this.#run(run)));
    }
    if (simSession) {
      this.#session = {
        table: simSession,
        layout: new RowLayout(simSession, simSessionDef, null),
      };
      this.publishSession(sim.clock());
    }
  }

  dispose() {
    for (const off of this.#unsubscribe) off();
  }

  #event(event: SimEvent) {
    if (!this.#events) return;
    const { table, layout } = this.#events;
    const { idx } = layout;
    const row = layout.row();
    row[idx.id] = String(event.seq);
    row[idx.seq] = event.seq;
    row[idx.time] = event.time;
    row[idx.user] = event.user;
    row[idx.action] = event.action;
    row[idx.target] = event.target;
    row[idx.details] = event.details;
    row[idx.runId] = event.runId;
    table.insert(row);
    this.#eventKeys.push(String(event.seq));
    if (this.#eventKeys.length > SIM_EVENTS_CAPACITY)
      table.delete(this.#eventKeys.shift() as string);
  }

  #run(run: ScenarioRun) {
    if (!this.#runs) return;
    const { table, layout } = this.#runs;
    const { idx } = layout;
    const row = layout.row();
    row[idx.runId] = run.runId;
    row[idx.name] = run.name;
    row[idx.status] = run.status;
    row[idx.user] = run.user;
    row[idx.targets] = run.targets.join(",");
    row[idx.args] = JSON.stringify(run.args);
    row[idx.startedAt] = run.startedAt;
    row[idx.step] = run.step;
    row[idx.steps] = run.steps;
    row[idx.nextAt] = run.nextAt ?? null;
    row[idx.reverted] = run.reverted;
    row[idx.error] = run.error;
    upsert(table, run.runId, row);
  }

  /** The session row (phase, next change, clock, paused bots, live runs). */
  publishSession(now: number) {
    if (!this.#session) return;
    const { sim } = this;
    const { table, layout } = this.#session;
    const { idx } = layout;
    const status = sim.sessionStatus(now);
    let paused = 0;
    for (const { bots } of sim.instrumentsFor())
      for (const bot of bots) if (bot.port.paused) paused++;
    const row = layout.row();
    row[idx.id] = SESSION_KEY;
    row[idx.phase] = status.phase;
    row[idx.nextPhase] = status.nextPhase ?? null;
    row[idx.nextChangeAt] = status.nextChangeAt ?? null;
    row[idx.forced] = status.forced;
    row[idx.forcedUntil] = status.forced ? (status.nextChangeAt ?? null) : null;
    row[idx.scheduled] = sim.session.scheduled;
    row[idx.timeOfDay] = sim.session.scheduled
      ? sim.session.timeOfDayLabel(now)
      : "";
    row[idx.timeScale] = sim.config.timeScale;
    row[idx.pausedBots] = paused;
    row[idx.runningScenarios] = sim.scenarios.runs.filter(
      (run) => run.status === ScenarioStatus.Running,
    ).length;
    upsert(table, SESSION_KEY, row);
  }
}
