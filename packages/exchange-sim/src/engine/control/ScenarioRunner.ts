import { BotType, RejectReason, TradingPhase } from "@heswell/trading-schemas";
import { Random } from "../../util/random";
import { ExchangeAdminError } from "../errors";
import type { ExchangeSimulator } from "../ExchangeSimulator";
import type { BookSettings } from "../persistence";
import type {
  ActionContext,
  BotSelector,
  InstrumentParams,
} from "./SimControl";

/** One timed action of a scenario. */
export interface ScenarioStep {
  /** "+30s" / "+2m" / "+500ms" after the start, or session time "HH:MM". */
  at: string;
  action: string;
  params?: Record<string, unknown>;
}

/** A scenario definition (packages/exchange-sim/scenarios/*.json). */
export interface ScenarioDef {
  name: string;
  description: string;
  /**
   * Default instruments: `rics`, every instrument of a `sector`, `random`
   * N instruments, or (none of these) every simulated instrument.
   */
  targets?: { rics?: string[]; sector?: string; random?: number | string };
  /** Defaults for `$name` references in step params (and in `targets.random`). */
  args?: Record<string, number | string>;
  steps: ScenarioStep[];
}

export const ScenarioStatus = Object.freeze({
  Running: "RUNNING",
  Done: "DONE",
  Stopped: "STOPPED",
  /** Live when the server stopped; its changes were reverted on restart. */
  Aborted: "ABORTED",
  Failed: "FAILED",
} as const);
export type ScenarioStatus =
  (typeof ScenarioStatus)[keyof typeof ScenarioStatus];

export interface ScenarioRun {
  runId: string;
  name: string;
  status: ScenarioStatus;
  user: string;
  targets: string[];
  args: Record<string, number | string>;
  startedAt: number;
  /** Steps done so far. */
  step: number;
  steps: number;
  /** Clock time of the next step (undefined when finished). */
  nextAt: number | undefined;
  /** Settings of each target before the run, for revert. */
  baseline: BookSettings[];
  reverted: boolean;
  error: string;
  /** Clock time of each step. */
  readonly times: number[];
}

/** What a live run saves (snapshot and journal) to be reverted after a restart. */
export interface SavedRun {
  runId: string;
  name: string;
  baseline: BookSettings[];
}

export type RunListener = (run: ScenarioRun) => void;

const fail = (text: string) =>
  new ExchangeAdminError(RejectReason.InvalidRequest, text);

/** Clock offset of a relative time ("+30s", "+2m", "+500ms"), else undefined. */
export const parseOffset = (at: string): number | undefined => {
  const match = /^\+(\d+(?:\.\d+)?)(ms|s|m)$/.exec(at.trim());
  if (!match) return undefined;
  const n = Number(match[1]);
  return match[2] === "ms" ? n : match[2] === "s" ? n * 1000 : n * 60_000;
};

/** Replace `$name` references in a step's params with the run's args. */
export const substituteArgs = (
  value: unknown,
  args: Record<string, number | string>,
): unknown => {
  if (typeof value === "string") {
    const whole = /^\$(?:\{(\w+)\}|(\w+))$/.exec(value);
    if (whole) {
      const name = whole[1] ?? whole[2];
      if (!(name in args)) throw fail(`missing scenario arg ${name}`);
      return args[name];
    }
    return value.replace(
      /\$(?:\{(\w+)\}|(\w+))/g,
      (_, braced: string, bare: string) => {
        const name = braced ?? bare;
        if (!(name in args)) throw fail(`missing scenario arg ${name}`);
        return String(args[name]);
      },
    );
  }
  if (Array.isArray(value)) return value.map((v) => substituteArgs(v, args));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, substituteArgs(v, args)]),
    );
  return value;
};

/** A number, or "x<f>" times `current`. */
const scaled = (value: unknown, current: number): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value === "string" && /^x/i.test(value.trim()))
    return current * Number(value.trim().slice(1));
  const n = Number(value);
  if (!Number.isFinite(n)) throw fail(`'${String(value)}' is not a number`);
  return n;
};

const str = (value: unknown) =>
  value === undefined ? undefined : String(value);

type StepAction = (
  runner: ScenarioRunner,
  run: ScenarioRun,
  params: Record<string, unknown>,
) => void;

/**
 * Runs scenarios: timed admin actions on a set of instruments, applied
 * through SimControl (so they show in simEvents with the run id). A run
 * saves its targets' settings first; `revert` (a step, or stopScenario with
 * revert) puts them back. More actions can be registered, e.g. by the OMS
 * when it runs in the same process.
 */
export class ScenarioRunner {
  readonly #defs = new Map<string, ScenarioDef>();
  readonly #actions = new Map<string, StepAction>();
  readonly #runs: ScenarioRun[] = [];
  readonly #listeners = new Set<RunListener>();
  #seq = 0;

  constructor(readonly sim: ExchangeSimulator) {
    for (const [name, action] of Object.entries(BUILT_IN_ACTIONS))
      this.registerAction(name, action);
  }

  registerAction(name: string, action: StepAction) {
    this.#actions.set(name, action);
  }

  get actionNames() {
    return [...this.#actions.keys()];
  }

  /** Add (or replace) scenario definitions; each step's action must exist. */
  define(...defs: ScenarioDef[]) {
    for (const def of defs) {
      for (const step of def.steps) {
        if (!this.#actions.has(step.action))
          throw Error(`scenario ${def.name}: unknown action ${step.action}`);
        const at = String(substituteArgs(step.at, def.args ?? {}));
        if (parseOffset(at) === undefined && !/^\d\d:\d\d$/.test(at))
          throw Error(`scenario ${def.name}: bad time ${step.at}`);
      }
      this.#defs.set(def.name, def);
    }
  }

  get definitions(): readonly ScenarioDef[] {
    return [...this.#defs.values()];
  }

  get runs(): readonly ScenarioRun[] {
    return this.#runs;
  }

  getRun(runId: string) {
    return this.#runs.find((run) => run.runId === runId);
  }

  onChange(listener: RunListener) {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #changed(run: ScenarioRun) {
    for (const listener of this.#listeners) listener(run);
  }

  #targets(
    def: ScenarioDef,
    rics: string[] | undefined,
    args: ScenarioRun["args"],
  ) {
    const all = this.sim.books.map((book) => book.ric);
    if (rics && rics.length > 0) {
      for (const ric of rics) this.sim.instrumentsFor(ric);
      return rics;
    }
    const t = def.targets ?? {};
    if (t.rics) return t.rics.filter((ric) => this.sim.isSimulated(ric));
    if (t.sector)
      return all.filter(
        (ric) => this.sim.getInstrument(ric)?.sector === t.sector,
      );
    if (t.random !== undefined) {
      const n = Number(substituteArgs(t.random, args));
      const rng = new Random(this.sim.config.seed * 7919 + this.#seq);
      const pool = [...all];
      const picked: string[] = [];
      while (picked.length < n && pool.length > 0)
        picked.push(pool.splice(rng.int(0, pool.length - 1), 1)[0]);
      return picked;
    }
    return all;
  }

  /** Start a scenario now; returns the run. */
  run(
    name: string,
    {
      rics,
      args = {},
    }: { rics?: string[]; args?: Record<string, number | string> } = {},
    ctx: ActionContext = {},
  ): ScenarioRun {
    const def = this.#defs.get(name);
    if (!def) throw fail(`unknown scenario ${name}`);
    const merged = { ...(def.args ?? {}), ...args };
    this.#seq++;
    const targets = this.#targets(def, rics, merged);
    if (targets.length === 0)
      throw fail(`scenario ${name}: no target instruments`);
    const now = this.sim.clock();
    const times = def.steps.map((step) => {
      const at = String(substituteArgs(step.at, merged));
      const offset = parseOffset(at);
      if (offset === undefined && !/^\d\d:\d\d$/.test(at))
        throw fail(`scenario ${name}: bad time ${at}`);
      return offset !== undefined
        ? now + offset
        : (this.sim.session.nextTimeOfDay(at, now) ?? now);
    });
    const run: ScenarioRun = {
      runId: `RUN${this.#seq}`,
      name,
      status: ScenarioStatus.Running,
      user: ctx.user ?? "",
      targets,
      args: merged,
      startedAt: now,
      step: 0,
      steps: def.steps.length,
      nextAt: times[0],
      baseline: targets.map((ric) => this.sim.settingsOf(ric)),
      reverted: false,
      error: "",
      times,
    };
    this.#runs.push(run);
    this.sim.journal({ k: "run", run: savedRun(run) });
    this.sim.control.record(
      "runScenario",
      targets.join(","),
      { name, args: merged },
      {
        ...ctx,
        runId: run.runId,
      },
    );
    this.#changed(run);
    this.step(now);
    return run;
  }

  /** Execute due steps of every live run (called by ExchangeSimulator.step). */
  step(now: number) {
    for (const run of this.#runs) {
      if (run.status !== ScenarioStatus.Running) continue;
      const def = this.#defs.get(run.name);
      let changed = false;
      while (run.status === ScenarioStatus.Running && run.step < run.steps) {
        const at = run.times[run.step];
        if (at > now) break;
        const step = def?.steps[run.step];
        run.step++;
        changed = true;
        if (!step) continue;
        try {
          const params = substituteArgs(step.params ?? {}, run.args) as Record<
            string,
            unknown
          >;
          this.#actions.get(step.action)?.(this, run, params);
        } catch (err) {
          run.status = ScenarioStatus.Failed;
          run.error = `step ${run.step} (${step.action}): ${(err as Error).message}`;
          this.#finish(run, true);
        }
      }
      if (run.status === ScenarioStatus.Running) {
        run.nextAt = run.times[run.step];
        if (run.step >= run.steps) {
          run.status = ScenarioStatus.Done;
          this.#finish(run, false);
        }
      }
      if (changed) this.#changed(run);
    }
  }

  #finish(run: ScenarioRun, revert: boolean) {
    run.nextAt = undefined;
    if (revert) this.revert(run);
    this.sim.journal({ k: "runEnd", runId: run.runId });
  }

  /** Put the run's targets back to their settings from before it started. */
  revert(run: ScenarioRun) {
    if (run.reverted) return;
    for (const settings of run.baseline) this.sim.applySettings(settings);
    run.reverted = true;
    this.sim.control.record(
      "revert",
      run.targets.join(","),
      { name: run.name },
      {
        runId: run.runId,
      },
    );
  }

  /** Stop a live run, optionally reverting its changes. */
  stop(runId: string, revert: boolean, ctx: ActionContext = {}) {
    const run = this.getRun(runId);
    if (!run) throw fail(`unknown scenario run ${runId}`);
    if (run.status === ScenarioStatus.Running) {
      run.status = ScenarioStatus.Stopped;
      this.#finish(run, false);
    }
    if (revert) this.revert(run);
    this.sim.control.record(
      "stopScenario",
      run.targets.join(","),
      { revert },
      {
        ...ctx,
        runId,
      },
    );
    this.#changed(run);
    return run;
  }

  /** Live runs, to save in a snapshot. */
  exportState(): SavedRun[] {
    return this.#runs
      .filter((run) => run.status === ScenarioStatus.Running)
      .map(savedRun);
  }

  /**
   * After a restart: runs that were live are reverted (their changes were
   * restored with the settings) and listed as aborted.
   */
  abortRestored(saved: readonly SavedRun[]) {
    for (const s of saved) {
      const n = Number(s.runId.replace(/^RUN/, ""));
      if (Number.isInteger(n)) this.#seq = Math.max(this.#seq, n);
      const now = this.sim.clock();
      const run: ScenarioRun = {
        runId: s.runId,
        name: s.name,
        status: ScenarioStatus.Aborted,
        user: "",
        targets: s.baseline.map((b) => b.ric),
        args: {},
        startedAt: now,
        step: 0,
        steps: this.#defs.get(s.name)?.steps.length ?? 0,
        nextAt: undefined,
        baseline: s.baseline.filter((b) => this.sim.isSimulated(b.ric)),
        reverted: false,
        error: "server restarted during the run",
        times: [],
      };
      this.revert(run);
      this.sim.journal({ k: "runEnd", runId: run.runId });
      this.#runs.push(run);
      this.#changed(run);
    }
  }
}

const savedRun = (run: ScenarioRun): SavedRun => ({
  runId: run.runId,
  name: run.name,
  baseline: run.baseline,
});

/** Apply `fn` to each target instrument of the run (or `params.ric` if given). */
const perRic =
  (
    fn: (
      runner: ScenarioRunner,
      run: ScenarioRun,
      ric: string,
      p: Record<string, unknown>,
    ) => void,
  ): StepAction =>
  (runner, run, params) => {
    const rics = params.ric ? [String(params.ric)] : run.targets;
    for (const ric of rics) fn(runner, run, ric, params);
  };

const selector = (ric: string, p: Record<string, unknown>): BotSelector => ({
  ric,
  ...(p.kind ? { kind: String(p.kind) } : {}),
});

const BUILT_IN_ACTIONS: Record<string, StepAction> = {
  setInstrumentParams: perRic((runner, run, ric, p) => {
    const { model } = runner.sim.instrumentsFor(ric)[0].book;
    const params: InstrumentParams = {
      volatility: scaled(p.volatility, model.volatility),
      driftBpsPerHour: scaled(p.driftBpsPerHour, model.driftBpsPerHour),
      impactBps: scaled(p.impactBps, model.impact.k * 1e4),
      impactPermanentShare: scaled(
        p.impactPermanentShare,
        model.impact.permanentShare,
      ),
      impactHalfLifeSec: scaled(p.impactHalfLifeSec, model.impact.halfLifeSec),
    };
    for (const key of Object.keys(params) as (keyof InstrumentParams)[])
      if (params[key] === undefined) delete params[key];
    runner.sim.control.setInstrumentParams(ric, params, { runId: run.runId });
  }),
  setBotRate: perRic((runner, run, ric, p) => {
    const sim = runner.sim.instrumentsFor(ric)[0];
    const bot = (str(p.bot) ?? BotType.All) as BotType;
    const current = bot === BotType.MarketMaker ? sim.mmRate : sim.takerRate;
    const rate = scaled(p.rate, current) ?? current;
    runner.sim.control.setBotRate(ric, bot, rate, { runId: run.runId });
  }),
  setBotParams: perRic((runner, run, ric, p) => {
    const { kind, botId, over, overSecs, ric: _ric, ...values } = p;
    const secs =
      overSecs !== undefined
        ? Number(overSecs)
        : over !== undefined
          ? (parseOffset(`+${String(over)}`) ?? 0) / 1000
          : 0;
    for (const [name, value] of Object.entries(values)) {
      runner.sim.control.setBotParams(
        botId ? { botId: String(botId) } : selector(ric, { kind }),
        name,
        String(value),
        secs,
        { runId: run.runId },
      );
    }
  }),
  shiftFairValue: perRic((runner, run, ric, p) => {
    runner.sim.control.shiftFairValue(ric, Number(p.bps), { runId: run.runId });
  }),
  pauseBots: perRic((runner, run, ric, p) => {
    runner.sim.control.pauseBots(selector(ric, p), { runId: run.runId });
  }),
  resumeBots: perRic((runner, run, ric, p) => {
    runner.sim.control.resumeBots(selector(ric, p), { runId: run.runId });
  }),
  pullQuotes: perRic((runner, run, ric, p) => {
    runner.sim.control.pullQuotes(selector(ric, p), { runId: run.runId });
  }),
  addBot: perRic((runner, run, ric, p) => {
    const { kind, ric: _ric, count = 1, ...params } = p;
    for (let i = 0; i < Number(count); i++) {
      runner.sim.control.addBot(
        ric,
        String(kind),
        Object.fromEntries(
          Object.entries(params).map(([k, v]) => [k, String(v)]),
        ),
        { runId: run.runId },
      );
    }
  }),
  halt: perRic((runner, run, ric, p) => {
    runner.sim.control.haltInstrument(
      ric,
      str(p.reason) ?? `scenario ${run.name}`,
      {
        runId: run.runId,
      },
    );
  }),
  resume: perRic((runner, run, ric) => {
    runner.sim.control.resumeInstrument(ric, false, { runId: run.runId });
  }),
  setMarketPhase: (runner, run, p) => {
    runner.sim.control.setMarketPhase(
      (str(p.phase) ?? TradingPhase.Continuous) as TradingPhase,
      {
        runId: run.runId,
      },
    );
  },
  revert: (runner, run) => runner.revert(run),
};
