import {
  BotType,
  RejectReason,
  type TradingPhase,
} from "@heswell/trading-schemas";
import {
  type Bot,
  BotKind,
  type BotParamSpec,
  type BotParamValue,
} from "../bots/Bot";
import { Informed } from "../bots/Informed";
import { botKindDef } from "../bots/roster";
import { ExchangeAdminError } from "../errors";
import type { ExchangeSimulator } from "../ExchangeSimulator";

/** Who made a change: the RPC caller, or a scenario run. */
export interface ActionContext {
  user?: string;
  runId?: string;
}

/** One applied change (the simEvents table). */
export interface SimEvent {
  seq: number;
  time: number;
  user: string;
  action: string;
  /** Instruments or bots changed (comma separated), "" = market-wide. */
  target: string;
  /** What changed, as JSON. */
  details: string;
  runId: string;
}

export type SimEventListener = (event: SimEvent) => void;

/** Which bots an action applies to; all fields optional (none = every bot). */
export interface BotSelector {
  ric?: string;
  kind?: string;
  botId?: string;
}

export interface InstrumentParams {
  volatility?: number;
  driftBpsPerHour?: number;
  /** Impact per $100k at 30% volatility, bps. */
  impactBps?: number;
  impactPermanentShare?: number;
  impactHalfLifeSec?: number;
}

interface Ramp {
  bot: Bot;
  name: string;
  from: number;
  to: number;
  start: number;
  end: number;
  integer: boolean;
}

const fail = (text: string) =>
  new ExchangeAdminError(RejectReason.InvalidRequest, text);

/**
 * Parse a parameter value for `spec`: absolute ("12", "true") or, for
 * numbers, relative to `current` ("x2" multiplies, "+3" / "-3" add).
 */
export const parseParamValue = (
  spec: BotParamSpec,
  text: string,
  current: BotParamValue | undefined,
): BotParamValue => {
  const value = text.trim();
  if (spec.type === "string") {
    if (spec.options && !spec.options.includes(value))
      throw fail(`${spec.name} must be one of ${spec.options.join(", ")}`);
    return value;
  }
  if (spec.type === "boolean") {
    if (value !== "true" && value !== "false")
      throw fail(`${spec.name} must be true or false`);
    return value === "true";
  }
  let n: number;
  const base = typeof current === "number" ? current : 0;
  if (/^x/i.test(value)) n = base * Number(value.slice(1));
  else if (/^[+-]\d/.test(value) && typeof current === "number")
    n = base + Number(value);
  else n = Number(value);
  if (!Number.isFinite(n))
    throw fail(`${spec.name}: '${text}' is not a number`);
  if (spec.type === "integer") n = Math.round(n);
  if (spec.min !== undefined) n = Math.max(spec.min, n);
  if (spec.max !== undefined) n = Math.min(spec.max, n);
  return n;
};

/**
 * Run-time control of the simulator: every admin action goes through here
 * (RPCs and scenario steps alike), is applied at once and is recorded as a
 * SimEvent. Ramps (setBotParams `overSecs`) advance on each step.
 */
export class SimControl {
  readonly #listeners = new Set<SimEventListener>();
  readonly #ramps: Ramp[] = [];
  #seq = 0;
  /** The most recent events, newest last (for tests and late subscribers). */
  readonly recent: SimEvent[] = [];

  constructor(readonly sim: ExchangeSimulator) {}

  onEvent(listener: SimEventListener) {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Record a change (also used for the original admin RPCs). */
  record(
    action: string,
    target: string,
    details: Record<string, unknown>,
    ctx: ActionContext = {},
  ) {
    const event: SimEvent = {
      seq: ++this.#seq,
      time: this.sim.clock(),
      user: ctx.user ?? (ctx.runId ? "scenario" : ""),
      action,
      target,
      details: JSON.stringify(details),
      runId: ctx.runId ?? "",
    };
    this.recent.push(event);
    if (this.recent.length > 200) this.recent.shift();
    for (const listener of this.#listeners) listener(event);
    return event;
  }

  // ---------------------------------------------------------------- bots

  /** Bots matching `selector` (throws for an unknown ric / bot / kind). */
  bots({ ric, kind, botId }: BotSelector): Bot[] {
    if (botId) {
      const bot = this.sim.getBot(botId);
      if (!bot) throw fail(`unknown bot ${botId}`);
      return [bot];
    }
    if (kind && !botKindDef(kind as BotKind))
      throw fail(`unknown bot kind ${kind}`);
    return this.sim
      .instrumentsFor(ric)
      .flatMap((sim) => sim.bots)
      .filter((bot) => !kind || bot.kind === kind);
  }

  #touch(bots: readonly Bot[]) {
    const rics = new Set(bots.map((bot) => bot.port.book.ric));
    for (const ric of rics) this.sim.journalSettings(ric);
    return [...rics];
  }

  #setParam(bot: Bot, name: string, value: BotParamValue) {
    bot.params = { ...bot.params, [name]: value };
    bot.onParamsChanged?.();
    const sim = this.sim.getSimulated(bot.port.book.ric);
    if (sim) this.sim.simAdminPublisher?.publishBotParams(sim, bot);
  }

  /**
   * Set one parameter on the selected bots, checked against the kind's
   * paramSpec. `overSecs` > 0 ramps a number linearly from its current
   * value. Returns the instruments affected.
   */
  setBotParams(
    selector: BotSelector,
    name: string,
    value: string,
    overSecs = 0,
    ctx: ActionContext = {},
  ): string[] {
    const bots = this.bots(selector).filter((bot) =>
      botKindDef(bot.kind).paramSpec.some((spec) => spec.name === name),
    );
    if (bots.length === 0)
      throw fail(`no selected bot has a parameter ${name}`);
    const now = this.sim.clock();
    for (const bot of bots) {
      const spec = botKindDef(bot.kind).paramSpec.find((s) => s.name === name);
      if (!spec) continue;
      if (spec.readOnly) throw fail(`${name} is read only`);
      const current = bot.params[name];
      const next = parseParamValue(spec, value, current);
      // a new ramp of the same parameter replaces the old one
      const old = this.#ramps.findIndex(
        (r) => r.bot === bot && r.name === name,
      );
      if (old >= 0) this.#ramps.splice(old, 1);
      if (
        overSecs > 0 &&
        typeof next === "number" &&
        typeof current === "number"
      ) {
        this.#ramps.push({
          bot,
          name,
          from: current,
          to: next,
          start: now,
          end: now + overSecs * 1000,
          integer: spec.type === "integer",
        });
      } else {
        this.#setParam(bot, name, next);
      }
    }
    const rics = this.#touch(bots);
    this.record(
      "setBotParams",
      targetOf(selector),
      { name, value, ...(overSecs > 0 ? { overSecs } : {}), bots: bots.length },
      ctx,
    );
    return rics;
  }

  /** Advance ramps (called by ExchangeSimulator.step). */
  step(now: number) {
    if (this.#ramps.length === 0) return;
    const touched = new Set<string>();
    for (let i = this.#ramps.length - 1; i >= 0; i--) {
      const r = this.#ramps[i];
      const f = Math.min(1, (now - r.start) / Math.max(1, r.end - r.start));
      let value = r.from + (r.to - r.from) * f;
      if (r.integer) value = Math.round(value);
      if (value !== r.bot.params[r.name]) {
        this.#setParam(r.bot, r.name, value);
        touched.add(r.bot.port.book.ric);
      }
      if (f >= 1) this.#ramps.splice(i, 1);
    }
    for (const ric of touched) this.sim.journalSettings(ric);
  }

  /** Ramps in progress (for tests). */
  get rampCount() {
    return this.#ramps.length;
  }

  pauseBots(selector: BotSelector, ctx: ActionContext = {}) {
    const bots = this.bots(selector);
    for (const bot of bots) {
      bot.port.paused = true;
      bot.pull();
    }
    this.record("pauseBots", targetOf(selector), { bots: bots.length }, ctx);
    return this.#touch(bots);
  }

  resumeBots(selector: BotSelector, ctx: ActionContext = {}) {
    const bots = this.bots(selector);
    for (const bot of bots) {
      bot.port.paused = false;
      bot.onParamsChanged?.();
    }
    this.record("resumeBots", targetOf(selector), { bots: bots.length }, ctx);
    return this.#touch(bots);
  }

  /** Cancel the selected bots' resting orders now (they requote unless paused). */
  pullQuotes(selector: BotSelector, ctx: ActionContext = {}) {
    const bots = this.bots(selector);
    for (const bot of bots) bot.pull();
    this.record("pullQuotes", targetOf(selector), { bots: bots.length }, ctx);
    return [...new Set(bots.map((bot) => bot.port.book.ric))];
  }

  addBot(
    ric: string,
    kind: string,
    params: Record<string, string> = {},
    ctx: ActionContext = {},
  ): Bot {
    const def = botKindDef(kind as BotKind);
    if (!def) throw fail(`unknown bot kind ${kind}`);
    const parsed: Record<string, BotParamValue> = {};
    for (const [name, text] of Object.entries(params)) {
      const spec = def.paramSpec.find((s) => s.name === name);
      if (!spec) throw fail(`${kind} has no parameter ${name}`);
      parsed[name] = parseParamValue(spec, text, undefined);
    }
    const bot = this.sim.addBot(ric, def.kind, parsed);
    this.sim.journalSettings(ric);
    this.record("addBot", bot.id, { kind, params }, ctx);
    return bot;
  }

  removeBot(botId: string, ctx: ActionContext = {}) {
    const bot = this.sim.removeBot(botId);
    this.sim.journalSettings(bot.port.book.ric);
    this.record("removeBot", botId, {}, ctx);
    return [bot.port.book.ric];
  }

  resetBotStats(selector: BotSelector, ctx: ActionContext = {}) {
    const bots = this.bots(selector);
    for (const bot of bots) {
      const { book } = bot.port;
      const top = book.topOfBook();
      const mark =
        top.bid > 0 && top.ask > 0
          ? (top.bid + top.ask) / 2
          : book.model.fairValue;
      bot.port.ledger.reset(mark);
    }
    this.record(
      "resetBotStats",
      targetOf(selector),
      { bots: bots.length },
      ctx,
    );
    return [...new Set(bots.map((bot) => bot.port.book.ric))];
  }

  // ---------------------------------------------------------------- instruments

  setInstrumentParams(
    ric: string | undefined,
    params: InstrumentParams,
    ctx: ActionContext = {},
  ): string[] {
    const targets = this.sim.instrumentsFor(ric);
    for (const { book } of targets) {
      const { model } = book;
      if (params.volatility !== undefined) model.volatility = params.volatility;
      if (params.driftBpsPerHour !== undefined)
        model.driftBpsPerHour = params.driftBpsPerHour;
      model.impact = {
        k:
          params.impactBps !== undefined
            ? params.impactBps / 1e4
            : model.impact.k,
        permanentShare:
          params.impactPermanentShare ?? model.impact.permanentShare,
        halfLifeSec: params.impactHalfLifeSec ?? model.impact.halfLifeSec,
      };
      book.dirty = true;
    }
    const rics = targets.map(({ book }) => book.ric);
    for (const r of rics) this.sim.journalSettings(r);
    this.record("setInstrumentParams", ric ?? "", { ...params }, ctx);
    return rics;
  }

  /** News jump: move fair value by `bps` at once. */
  /**
   * News jump: move fair value by `bps` at once. `informedSecs` > 0 arms the
   * instrument's informed traders (adding one if it has none) for that long.
   */
  shiftFairValue(
    ric: string,
    bps: number,
    ctx: ActionContext = {},
    informedSecs = 0,
  ) {
    const [sim] = this.sim.instrumentsFor(ric);
    const { book } = sim;
    const moved = book.model.shift(bps);
    book.dirty = true;
    let informed: string[] = [];
    if (informedSecs > 0) {
      let bots = sim.bots.filter(
        (bot): bot is Informed => bot instanceof Informed,
      );
      if (bots.length === 0)
        bots = [this.addBot(ric, BotKind.Informed, {}, ctx) as Informed];
      const until = this.sim.clock() + informedSecs * 1000;
      for (const bot of bots) {
        bot.port.paused = false;
        bot.arm(until);
      }
      informed = bots.map((bot) => bot.id);
    }
    this.record(
      "shiftFairValue",
      ric,
      {
        bps,
        moved: Math.round(moved * 100) / 100,
        ...(informedSecs > 0 ? { informedSecs, informed } : {}),
      },
      ctx,
    );
    return [ric];
  }

  // ---------------------------------------------------------------- wrapped

  setVolatility(
    ric: string | undefined,
    volatility: number,
    ctx: ActionContext = {},
  ) {
    const rics = this.sim.setVolatility(ric, volatility);
    this.record("setVolatility", ric ?? "", { volatility }, ctx);
    return rics;
  }

  haltInstrument(ric: string, reason?: string, ctx: ActionContext = {}) {
    const rics = this.sim.haltInstrument(ric, reason);
    this.record("haltInstrument", ric, { reason: reason ?? "" }, ctx);
    return rics;
  }

  resumeInstrument(ric: string, auction?: boolean, ctx: ActionContext = {}) {
    const rics = this.sim.resumeInstrument(ric, auction);
    this.record("resumeInstrument", ric, {}, ctx);
    return rics;
  }

  setBotRate(
    ric: string | undefined,
    bot: BotType | undefined,
    rate: number,
    ctx: ActionContext = {},
  ) {
    const rics = this.sim.setBotRate(ric, bot ?? BotType.All, rate);
    this.record(
      "setBotRate",
      ric ?? "",
      { bot: bot ?? BotType.All, rate },
      ctx,
    );
    return rics;
  }

  setMarketPhase(phase: TradingPhase, ctx: ActionContext = {}) {
    const rics = this.sim.setMarketPhase(phase as never);
    this.record("setMarketPhase", "", { phase }, ctx);
    return rics;
  }
}

const targetOf = ({ ric, kind, botId }: BotSelector) =>
  botId ?? [ric, kind].filter(Boolean).join(" ");
