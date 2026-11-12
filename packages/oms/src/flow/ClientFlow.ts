import {
  type BotParamValue,
  parseParamValue,
  Random,
} from "@heswell/exchange-sim/engine";
import {
  activityAt,
  AlgoStrategy,
  CLIENT_PERSONAS,
  type ClientPersona,
  ClientSideMode,
  type CreateOrderRequest,
  isSessionOpen,
  isTerminalStatus,
  OrdType,
  RejectReason,
  roundToLot,
  roundToTick,
  type SessionSchedule,
  Side,
  TimeInForce,
  tickScheduleOf,
  UNSCHEDULED,
  usdPerUnit,
} from "@heswell/trading-schemas";
import {
  executionQuality,
  type OmsEngine,
  type ParentOrder,
} from "../engine/OmsEngine";
import type { OmsGateway } from "../engine/gateway";
import { type Account, SIM_CLIENTS_DESK } from "../reference/accounts";
import { referencePrice } from "../risk/preTradeRisk";
import {
  CLIENT_PARAM_SPECS,
  type ClientBotParams,
  type ClientParamName,
  PERSONA_DEFAULTS,
} from "./clientPersonas";

/** A rejected client admin request (reason + text, as an RPC error). */
export class ClientAdminError extends Error {
  constructor(
    readonly reason: RejectReason,
    text: string,
  ) {
    super(text);
  }
}

const fail = (text: string) =>
  new ClientAdminError(RejectReason.InvalidRequest, text);

/** Who made a change: an RPC caller or a scenario run (as SimControl). */
export interface ClientActionContext {
  user?: string;
  runId?: string;
}

/** One applied change, for the simulator's control log (simEvents). */
export interface ClientFlowEvent {
  action: string;
  /** Bot ids (comma separated), or "" for the background flow. */
  target: string;
  details: Record<string, unknown>;
  ctx: ClientActionContext;
}

/** What the exchange can tell the client bots (when it runs in-process). */
export interface ClientMarketHooks {
  /** The exchange's hidden fair value (informed side mode). */
  fairValue?(ric: string): number | undefined;
  /** Instrument sector (universe `sector:<name>`). */
  sectorOf?(ric: string): string | undefined;
}

/** Which client bots: one, or every bot of a persona; neither = all. */
export interface ClientBotSelector {
  botId?: string;
  persona?: string;
}

/** Totals over a bot's parent orders. */
interface Tally {
  filledQty: number;
  filledUsd: number;
  /** Sum of slippage bps × filled USD. */
  slippageUsd: number;
}

const emptyTally = (): Tally => ({
  filledQty: 0,
  filledUsd: 0,
  slippageUsd: 0,
});

/** One simulated client: a persona trading one account. */
export class ClientBot {
  paused = false;
  submitted = 0;
  rejected = 0;
  completed = 0;
  lastOrderId = "";
  lastReject = "";
  /** Working parent orders. */
  readonly live = new Set<string>();
  /** Fills of finished parents. */
  readonly done: Tally = emptyTally();
  readonly baseline: Readonly<ClientBotParams>;
  carry = 0;

  constructor(
    readonly id: string,
    readonly persona: ClientPersona,
    readonly account: Account,
    readonly params: ClientBotParams,
    readonly random: Random,
  ) {
    this.baseline = Object.freeze({ ...params });
  }
}

/** A bot's settings, to put back on a scenario revert. */
export interface ClientBotSnapshot {
  botId: string;
  params: ClientBotParams;
  paused: boolean;
}

export interface ClientFlowOptions {
  engine: OmsEngine;
  gateway: OmsGateway;
  /** Instruments to trade by default (an empty universe). */
  rics: () => readonly string[];
  seed: number;
  /** Interval of clientBots rows (ms of clock time). */
  publishMs?: number;
  clock: () => number;
}

/** Parse `persona:count,...` (oms.clientBots). */
export const parseClientBots = (text: string) =>
  text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [persona, count = "1"] = entry.split(":").map((s) => s.trim());
      if (!(CLIENT_PERSONAS as readonly string[]).includes(persona))
        throw Error(
          `oms.clientBots: unknown persona ${persona} (one of ${CLIENT_PERSONAS.join(", ")})`,
        );
      const n = Number(count);
      if (!(Number.isInteger(n) && n >= 0))
        throw Error(`oms.clientBots: bad count in ${entry}`);
      return { persona: persona as ClientPersona, count: n };
    });

const SPECS = new Map(CLIENT_PARAM_SPECS.map((spec) => [spec.name, spec]));

const valueText = (value: unknown) => String(value);

const weighted = <T>(random: Random, items: [T, number][]) => {
  const total = items.reduce((sum, [, w]) => sum + Math.max(0, w), 0);
  if (!(total > 0)) return undefined;
  let roll = random.next() * total;
  for (const [item, w] of items) {
    roll -= Math.max(0, w);
    if (roll < 0) return item;
  }
  return items[items.length - 1][0];
};

/**
 * Simulated clients (OMS client bots): each sends TWAP / VWAP / POV parent
 * orders through `engine.createOrder` for its account, so risk, routing,
 * positions, slippage and execution quality apply as for any client order.
 * Arrivals are a Poisson stream at `ordersPerMin`, scaled by the session's
 * volume curve; each arrival adds a parent, or amends / cancels a working
 * one. Bots are added from `oms.clientBots`, the admin RPCs or scenarios.
 */
export class ClientFlow {
  readonly #bots = new Map<string, ClientBot>();
  readonly #listeners = new Set<(event: ClientFlowEvent) => void>();
  readonly #rowListeners = new Set<(bot: ClientBot) => void>();
  readonly #removeListeners = new Set<(bot: ClientBot) => void>();
  #seq = 0;
  #lastPublish = Number.NEGATIVE_INFINITY;
  /** Exchange hooks (set by connectClientFlowToSim). */
  market: ClientMarketHooks = {};

  constructor(private options: ClientFlowOptions) {}

  get bots(): readonly ClientBot[] {
    return [...this.#bots.values()];
  }

  getBot(botId: string) {
    return this.#bots.get(botId);
  }

  /** Admin changes (RPCs and scenario steps), for the control log. */
  onEvent(listener: (event: ClientFlowEvent) => void) {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** A bot's row changed (stats on the publish interval, or settings). */
  onBotChange(listener: (bot: ClientBot) => void) {
    this.#rowListeners.add(listener);
    return () => {
      this.#rowListeners.delete(listener);
    };
  }

  onBotRemoved(listener: (bot: ClientBot) => void) {
    this.#removeListeners.add(listener);
    return () => {
      this.#removeListeners.delete(listener);
    };
  }

  #record(
    action: string,
    target: string,
    details: Record<string, unknown>,
    ctx: ClientActionContext,
  ) {
    for (const listener of this.#listeners)
      listener({ action, target, details, ctx });
  }

  /** Log a BackgroundFlow change (setFlowParams) with the client events. */
  recordFlowChange(params: object, ctx: ClientActionContext = {}) {
    this.#record("setFlowParams", "", { ...params }, ctx);
  }

  #changed(bot: ClientBot) {
    for (const listener of this.#rowListeners) listener(bot);
  }

  #schedule(): SessionSchedule {
    return this.options.gateway.getSessionSchedule?.() ?? UNSCHEDULED;
  }

  // ---------------------------------------------------------------- admin

  /** Bots matching `selector` (throws for an unknown bot or persona). */
  select({ botId, persona }: ClientBotSelector): ClientBot[] {
    if (botId) {
      const bot = this.#bots.get(botId);
      if (!bot) throw fail(`unknown client bot ${botId}`);
      return [bot];
    }
    if (persona && !(CLIENT_PERSONAS as readonly string[]).includes(persona))
      throw fail(`unknown persona ${persona}`);
    return this.bots.filter((bot) => !persona || bot.persona === persona);
  }

  /** The account a new bot trades: the least used Sim clients account. */
  #nextAccount(): Account {
    const accounts = [...this.options.engine.accounts.values()].filter(
      (a) => a.desk === SIM_CLIENTS_DESK && a.enabled,
    );
    if (accounts.length === 0)
      throw fail(
        "no Sim clients accounts (oms.clientAccounts is 0): pass an account",
      );
    const uses = (a: Account) =>
      this.bots.filter((bot) => bot.account.account === a.account).length;
    return accounts.reduce((best, a) => (uses(a) < uses(best) ? a : best));
  }

  /** Add a bot of `persona` with parameter overrides (as text or values). */
  add(
    persona: string,
    {
      account: accountId,
      params = {},
    }: { account?: string; params?: Record<string, unknown> } = {},
    ctx: ClientActionContext = {},
  ): ClientBot {
    if (!(CLIENT_PERSONAS as readonly string[]).includes(persona))
      throw fail(`unknown persona ${persona}`);
    let account: Account;
    if (accountId) {
      const found = this.options.engine.accounts.get(accountId);
      if (!found) throw fail(`unknown account ${accountId}`);
      if (!found.enabled) throw fail(`account ${accountId} is disabled`);
      account = found;
    } else {
      account = this.#nextAccount();
    }
    const n = ++this.#seq;
    const random = new Random(this.options.seed).fork(n * 7_919);
    const values: ClientBotParams = {
      ...PERSONA_DEFAULTS[persona as ClientPersona],
    };
    // a programme picks its side at random unless told
    if (values.sideMode === ClientSideMode.Programme && !params.programmeSide)
      values.programmeSide =
        persona === "liquidation"
          ? Side.Sell
          : random.chance(0.5)
            ? Side.Buy
            : Side.Sell;
    for (const [name, value] of Object.entries(params))
      this.#assign(values, name, valueText(value));
    const bot = new ClientBot(
      `CB${n}`,
      persona as ClientPersona,
      account,
      values,
      random,
    );
    this.#bots.set(bot.id, bot);
    this.#record(
      "addClientBot",
      bot.id,
      { persona, account: account.account, params },
      ctx,
    );
    this.#changed(bot);
    return bot;
  }

  /** Remove a bot, cancelling its working parents. */
  remove(botId: string, ctx: ClientActionContext = {}) {
    const [bot] = this.select({ botId });
    this.#cancelLive(bot);
    this.#bots.delete(botId);
    this.#record("removeClientBot", botId, {}, ctx);
    for (const listener of this.#removeListeners) listener(bot);
    return [botId];
  }

  #assign(values: ClientBotParams, name: string, text: string) {
    const spec = SPECS.get(name as ClientParamName);
    if (!spec) throw fail(`unknown client bot parameter ${name}`);
    const record = values as unknown as Record<string, BotParamValue>;
    try {
      record[name] = parseParamValue(spec, text, record[name]);
    } catch (err) {
      throw fail((err as Error).message);
    }
  }

  /** Set one parameter on the selected bots; returns their ids. */
  setParams(
    selector: ClientBotSelector,
    name: string,
    value: string,
    ctx: ClientActionContext = {},
  ) {
    const bots = this.select(selector);
    for (const bot of bots) this.#assign(bot.params, name, value);
    const ids = bots.map((bot) => bot.id);
    this.#record("setClientBotParams", ids.join(","), { name, value }, ctx);
    for (const bot of bots) this.#changed(bot);
    return ids;
  }

  /** Stop / restart new orders (working parents keep going). */
  setPaused(
    selector: ClientBotSelector,
    paused: boolean,
    ctx: ClientActionContext = {},
  ) {
    const bots = this.select(selector);
    for (const bot of bots) bot.paused = paused;
    const ids = bots.map((bot) => bot.id);
    this.#record(
      paused ? "pauseClientBots" : "resumeClientBots",
      ids.join(","),
      {},
      ctx,
    );
    for (const bot of bots) this.#changed(bot);
    return ids;
  }

  snapshot(bot: ClientBot): ClientBotSnapshot {
    return { botId: bot.id, params: { ...bot.params }, paused: bot.paused };
  }

  /** Put a bot back to a snapshot (scenario revert); no-op if removed. */
  restore(snapshot: ClientBotSnapshot) {
    const bot = this.#bots.get(snapshot.botId);
    if (!bot) return;
    Object.assign(bot.params, snapshot.params);
    bot.paused = snapshot.paused;
    this.#changed(bot);
  }

  /**
   * One parent order now for `botId` (submitClientAlgo). Fields left out
   * come from the bot's parameters, as for its own orders.
   */
  submit(
    botId: string,
    request: {
      ric: string;
      side?: Side;
      notionalUsd?: number;
      quantity?: number;
      strategy?: AlgoStrategy;
      durationMins?: number;
      participationPct?: number;
      limitBps?: number;
    },
    ctx: ClientActionContext = {},
  ) {
    const [bot] = this.select({ botId });
    const result = this.#newOrder(bot, request);
    if (!result) throw fail(`${request.ric}: no market to price the order`);
    this.#record(
      "submitClientAlgo",
      botId,
      { ...request, orderId: result.ok ? result.value.orderId : "" },
      ctx,
    );
    this.#changed(bot);
    return result;
  }

  // ---------------------------------------------------------------- stepping

  /** Advance every bot by elapsed ms (the OMS flow timer, or tests). */
  step(elapsedMs: number) {
    if (this.#bots.size === 0) return;
    const { clock } = this.options;
    const now = clock();
    const schedule = this.#schedule();
    const open = isSessionOpen(schedule, now);
    const activity = activityAt(schedule, now);
    for (const bot of this.#bots.values()) {
      this.#track(bot);
      const { ordersPerMin } = bot.params;
      if (bot.paused || !open || !(ordersPerMin > 0)) {
        bot.carry = 0;
        continue;
      }
      bot.carry += (ordersPerMin * activity * elapsedMs) / 60_000;
      const n = bot.random.poisson(bot.carry);
      bot.carry = 0;
      for (let i = 0; i < n; i++) this.#arrival(bot);
    }
    if (now - this.#lastPublish >= (this.options.publishMs ?? 500)) {
      this.#lastPublish = now;
      for (const bot of this.#bots.values()) this.#changed(bot);
    }
  }

  /** Move finished parents from `live` into the bot's totals. */
  #track(bot: ClientBot) {
    const { engine } = this.options;
    for (const orderId of bot.live) {
      const order = engine.getOrder(orderId);
      if (!order) {
        bot.live.delete(orderId);
        continue;
      }
      if (!isTerminalStatus(order.state.status)) continue;
      bot.live.delete(orderId);
      bot.completed++;
      this.#addFills(bot.done, order);
    }
  }

  #addFills(tally: Tally, order: ParentOrder) {
    const { cumQty, avgPx } = order.state;
    if (!(cumQty > 0)) return;
    const instrument = this.options.gateway.getInstrument(order.ric);
    const usdPer = instrument ? usdPerUnit(instrument) : 1;
    const usd = cumQty * avgPx * usdPer;
    tally.filledQty += cumQty;
    tally.filledUsd += usd;
    tally.slippageUsd += executionQuality(order).slippageBps * usd;
  }

  /** Fills so far: finished parents plus the working ones. */
  stats(bot: ClientBot) {
    const total = { ...bot.done };
    for (const orderId of bot.live) {
      const order = this.options.engine.getOrder(orderId);
      if (order) this.#addFills(total, order);
    }
    return {
      live: bot.live.size,
      filledQty: total.filledQty,
      filledUsd: total.filledUsd,
      slippageBps:
        total.filledUsd > 0
          ? Math.round((total.slippageUsd / total.filledUsd) * 100) / 100
          : 0,
    };
  }

  #liveOrders(bot: ClientBot) {
    const orders: ParentOrder[] = [];
    for (const orderId of bot.live) {
      const order = this.options.engine.getOrder(orderId);
      if (order && !isTerminalStatus(order.state.status)) orders.push(order);
    }
    return orders;
  }

  #arrival(bot: ClientBot) {
    const { random, params } = bot;
    const live = this.#liveOrders(bot);
    const change = params.amendChance + params.cancelChance;
    if (
      live.length > 0 &&
      (live.length >= params.maxLive || random.chance(Math.min(1, change)))
    ) {
      if (change > 0) {
        const order = random.pick(live);
        if (random.next() * change < params.amendChance)
          this.#amend(bot, order);
        else this.#cancel(bot, order);
      }
      return;
    }
    if (live.length < params.maxLive) this.#newOrder(bot, {});
  }

  #amend(bot: ClientBot, order: ParentOrder) {
    const instrument = this.options.gateway.getInstrument(order.ric);
    if (!instrument) return;
    const factor = bot.random.uniform(0.7, 1.3);
    const quantity = Math.max(
      order.state.cumQty + instrument.lotSize,
      roundToLot(order.state.quantity * factor, instrument.lotSize),
    );
    if (quantity === order.state.quantity) return;
    const result = this.options.engine.amendOrder(
      { orderId: order.orderId, quantity },
      { user: bot.account.owner },
    );
    if (!result.ok) bot.lastReject = `${result.reason}: ${result.text}`;
  }

  #cancel(bot: ClientBot, order: ParentOrder) {
    this.options.engine.cancelOrder(
      { orderId: order.orderId },
      { user: bot.account.owner },
    );
  }

  #cancelLive(bot: ClientBot) {
    for (const order of this.#liveOrders(bot)) this.#cancel(bot, order);
  }

  #universe(bot: ClientBot): readonly string[] {
    const text = bot.params.universe.trim();
    if (!text) return this.options.rics();
    const sector = /^sector:(.+)$/i.exec(text);
    if (sector) {
      const name = sector[1].trim().toLowerCase();
      return this.options
        .rics()
        .filter((ric) => this.market.sectorOf?.(ric)?.toLowerCase() === name);
    }
    return text
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  #side(bot: ClientBot, ric: string, mid: number): Side | undefined {
    const { random, params } = bot;
    const { gateway, engine } = this.options;
    const instrument = gateway.getInstrument(ric);
    if (!instrument) return undefined;
    const coin = () => (random.chance(0.5) ? Side.Buy : Side.Sell);
    const position = engine.getPosition(bot.account.account, ric);
    const positionUsd =
      (position?.quantity ?? 0) * mid * usdPerUnit(instrument);
    const limit = bot.account.maxPositionNotional;
    let side: Side | undefined;
    switch (params.sideMode) {
      case ClientSideMode.Programme:
        side = params.programmeSide;
        break;
      case ClientSideMode.PositionReverting: {
        const lean = positionUsd / (limit * 0.25);
        side =
          Math.abs(lean) > 1 || random.chance(Math.min(0.9, Math.abs(lean)))
            ? lean > 0
              ? Side.Sell
              : Side.Buy
            : coin();
        break;
      }
      case ClientSideMode.Momentum: {
        const ref = instrument.refPrice;
        const move = ref > 0 ? (mid - ref) / ref : 0;
        // the bigger the day's move, the surer the side
        const p = 0.5 + Math.min(0.45, Math.abs(move) * 50);
        const withMove = move >= 0 ? Side.Buy : Side.Sell;
        side = random.chance(p)
          ? withMove
          : withMove === Side.Buy
            ? Side.Sell
            : Side.Buy;
        break;
      }
      case ClientSideMode.Informed: {
        const fair = this.market.fairValue?.(ric);
        if (!(fair && fair > 0 && mid > 0)) return undefined;
        const gapBps = ((fair - mid) / mid) * 1e4;
        if (Math.abs(gapBps) < params.informedThresholdBps) return undefined;
        side = gapBps > 0 ? Side.Buy : Side.Sell;
        break;
      }
      default:
        side = coin();
    }
    // stay inside the position limit: never add past 80% of it
    const adds = side === Side.Buy ? positionUsd > 0 : positionUsd < 0;
    if (adds && Math.abs(positionUsd) > limit * 0.8) return undefined;
    return side;
  }

  #newOrder(
    bot: ClientBot,
    request: {
      ric?: string;
      side?: Side;
      notionalUsd?: number;
      quantity?: number;
      strategy?: AlgoStrategy;
      durationMins?: number;
      participationPct?: number;
      limitBps?: number;
    },
  ): ReturnType<OmsEngine["createOrder"]> | undefined {
    const { random, params, account } = bot;
    const { engine, gateway } = this.options;
    let ric = request.ric;
    if (!ric) {
      const universe = this.#universe(bot);
      if (universe.length === 0) return undefined;
      ric = random.pick(universe);
    }
    const instrument = gateway.getInstrument(ric);
    const top = gateway.getTopOfBook(ric);
    if (!instrument || !top) return undefined;
    const mid =
      top.bid > 0 && top.ask > 0
        ? (top.bid + top.ask) / 2
        : referencePrice(instrument, top);
    if (!(mid > 0)) return undefined;
    const side = request.side ?? this.#side(bot, ric, mid);
    if (!side) return undefined;

    const usdPer = usdPerUnit(instrument);
    let quantity = request.quantity;
    if (quantity === undefined) {
      const lo = Math.max(1_000, params.minNotionalUsd);
      const hi = Math.max(lo, params.maxNotionalUsd);
      const usd =
        request.notionalUsd ??
        Math.exp(random.uniform(Math.log(lo), Math.log(hi)));
      quantity = usd / (mid * usdPer);
    }
    const capQty = Math.min(
      account.maxOrderQty,
      (account.maxOrderNotional * 0.9) / (mid * usdPer),
    );
    quantity = Math.max(
      instrument.lotSize,
      roundToLot(Math.min(quantity, capQty), instrument.lotSize, "down"),
    );

    const strategy =
      request.strategy ??
      weighted<AlgoStrategy>(random, [
        [AlgoStrategy.Twap, params.twapWeight],
        [AlgoStrategy.Vwap, params.vwapWeight],
        [AlgoStrategy.Pov, params.povWeight],
      ]) ??
      AlgoStrategy.Twap;
    const lo = Math.min(params.minDurationMins, params.maxDurationMins);
    const hi = Math.max(params.minDurationMins, params.maxDurationMins);
    const durationMins =
      request.durationMins ?? Math.round(random.uniform(lo, hi) * 10) / 10;
    const povLo = Math.min(params.minPovPct, params.maxPovPct);
    const povHi = Math.max(params.minPovPct, params.maxPovPct);
    const participationPct =
      request.participationPct ??
      Math.round(random.uniform(povLo, povHi) * 10) / 10;

    // a limit through arrival, inside the OMS price collar
    const limitBps = Math.min(
      request.limitBps ?? params.limitBps,
      engine.collarPct * 1e4 * 0.9,
    );
    const sign = side === Side.Buy ? 1 : -1;
    const limit: Pick<CreateOrderRequest, "ordType" | "price"> =
      limitBps > 0
        ? {
            ordType: OrdType.Limit,
            price: roundToTick(
              mid * (1 + (sign * limitBps) / 1e4),
              tickScheduleOf(instrument),
              sign > 0 ? "down" : "up",
            ),
          }
        : { ordType: OrdType.Market };

    const result = engine.createOrder(
      {
        account: account.account,
        ric,
        side,
        quantity,
        timeInForce: TimeInForce.Day,
        strategy,
        durationMins,
        ...(strategy === AlgoStrategy.Pov ? { participationPct } : {}),
        ...limit,
      },
      { user: account.owner },
    );
    bot.submitted++;
    if (result.ok) {
      bot.live.add(result.value.orderId);
      bot.lastOrderId = result.value.orderId;
    } else {
      bot.rejected++;
      bot.lastReject = `${result.reason}: ${result.text}`;
    }
    return result;
  }
}
