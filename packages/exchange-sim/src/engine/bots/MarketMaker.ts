import { Side as BookSide, type Trade } from "@heswell/hft-limit-order-book";
import {
  BotType,
  roundToLot,
  roundToTick,
  stepTicks,
  tickSizeAt,
} from "@heswell/trading-schemas";
import type { Random } from "../../util/random";
import type { InstrumentBook } from "../InstrumentBook";
import {
  type Bot,
  type BotCreateOptions,
  BotKind,
  type BotKindDef,
  type BotStepContext,
} from "./Bot";
import { num } from "./common";
import type { OrderPort } from "./OrderPort";

export type MarketMakerParams = {
  readonly levels: number;
  /** Distance from (skewed) fair value to the best quote. */
  readonly halfSpreadTicks: number;
  /** Distance between quote levels. */
  readonly spacingTicks: number;
  /** Typical size of the best level. */
  readonly baseQty: number;
  /** Lag of the maker's fair-value estimate (half-life, s; 0 = none). */
  readonly fairHalfLifeSecs: number;
  /** Estimate shift per unit of trade imbalance (bps; 0 = none). */
  readonly flowSensitivityBps: number;
  /** Spread widening per unit of excess realised volatility (0 = off). */
  readonly volSensitivity: number;
  /** Widest spread (and smallest size) as a multiple of normal. */
  readonly maxWiden: number;
  /** Stop quoting the side that adds beyond this inventory (0 = off). */
  readonly maxInventory: number;
  /** Flatten with a market order back to maxInventory beyond this (0 = off). */
  readonly flattenAt: number;
  /** Pull everything when mid moves this far from its 1s average (0 = off). */
  readonly pullMoveBps: number;
  /** After a pull: seconds without quotes, then as long quoting twice as wide. */
  readonly cooldownSecs: number;
};

/** Phase 4 maker settings; the defaults leave the maker as before. */
export const MM_STRESS_DEFAULTS = Object.freeze({
  fairHalfLifeSecs: 0,
  flowSensitivityBps: 0,
  volSensitivity: 0,
  maxWiden: 4,
  maxInventory: 0,
  flattenAt: 0,
  pullMoveBps: 0,
  cooldownSecs: 5,
});

interface Quote {
  id: string;
  side: BookSide;
  price: number;
  size: number;
  targetSize: number;
}

/**
 * Quotes a ladder of `levels` orders each side of fair value, skewed against
 * its inventory. On every step it reconciles the resting ladder with the
 * target ladder using cancel/replace (modify) of the levels that no longer
 * fit, so a one-tick move costs ~one modify per side rather than a full
 * requote. Partially filled levels are topped up and a Poisson stream of
 * discretionary cancel/new adds realistic churn (the step rate).
 */
export class MarketMaker implements Bot {
  readonly kind = BotKind.MarketMaker;
  readonly id: string;
  readonly account: string;
  readonly #quotes = new Map<string, Quote>();
  #lastCentre = Number.NaN;
  #stale = true;
  /** Lagged fair-value estimate (NaN until the first step). */
  #estimate = Number.NaN;
  /** Spread multiple in force (1 = normal). */
  #widen = 1;
  /** Sides not quoted because of inventory. */
  #skipBuy = false;
  #skipSell = false;
  #pulledUntil = 0;
  #wideUntil = 0;

  constructor(
    readonly localId: string,
    public params: MarketMakerParams,
    readonly port: OrderPort,
    private readonly rng: Random,
  ) {
    this.id = port.botId;
    this.account = port.account;
    port.setFillListener((orderId, trade) => this.#onFill(orderId, trade));
  }

  /** Requote on the next step with the new spread / levels / size. */
  onParamsChanged() {
    this.#stale = true;
  }

  get book(): InstrumentBook {
    return this.port.book;
  }

  /** Net inventory (from the ledger). */
  get position() {
    return this.port.ledger.position;
  }

  get quoteCount() {
    return this.#quotes.size;
  }

  quotes(): readonly Quote[] {
    return [...this.#quotes.values()];
  }

  #onFill(orderId: string, trade: Trade) {
    const quote = this.#quotes.get(orderId);
    if (!quote) return;
    quote.size -= trade.size;
    if (quote.size <= 0) this.#quotes.delete(orderId);
    this.#stale = true;
  }

  /** The maker's fair-value estimate (fair value itself without lag). */
  get estimate() {
    return this.#estimate > 0 ? this.#estimate : this.book.model.fairValue;
  }

  /** Spread multiple in force: 1 normally, more under stress. */
  get widen() {
    return this.#widen;
  }

  /** Half spread in force, ticks. */
  get halfSpread() {
    return Math.max(1, Math.round(this.params.halfSpreadTicks * this.#widen));
  }

  /** True while pulled after a fast market. */
  isPulled(now: number) {
    return now < this.#pulledUntil;
  }

  /** Inventory skew of the quote centre, in ticks (bounded so MMs don't cross each other). */
  skewTicks() {
    const { baseQty } = this.params;
    const halfSpreadTicks = this.halfSpread;
    const max = Math.max(0, halfSpreadTicks - 1);
    const raw = Math.round(-this.position / (baseQty * 4));
    return Math.max(-max, Math.min(max, raw));
  }

  extraStats() {
    return {
      skewTicks: this.skewTicks(),
      quotes: this.#quotes.size,
      widen: this.#widen,
    };
  }

  /** Move the estimate towards fair value (and the flow), per the lag settings. */
  #updateEstimate(dt: number, imbalance: number) {
    const { fairHalfLifeSecs, flowSensitivityBps } = this.params;
    const fair = this.book.model.fairValue;
    if (!(fairHalfLifeSecs > 0) || !(this.#estimate > 0)) this.#estimate = fair;
    else
      this.#estimate +=
        (1 - 0.5 ** (dt / fairHalfLifeSecs)) * (fair - this.#estimate);
    if (flowSensitivityBps === 0) return this.#estimate;
    return this.#estimate * (1 + (flowSensitivityBps * imbalance) / 1e4);
  }

  /** Spread multiple for the stress and cooldown now, in steps of 0.5. */
  #widenFor(stress: number, now: number) {
    const { volSensitivity, maxWiden } = this.params;
    let widen = 1;
    if (volSensitivity > 0 && stress > 1)
      widen += volSensitivity * (stress - 1);
    if (now < this.#wideUntil) widen *= 2;
    widen = Math.min(Math.max(1, maxWiden), widen);
    return Math.round(widen * 2) / 2;
  }

  /** Market order back to maxInventory when the inventory is past flattenAt. */
  #flatten() {
    const { flattenAt, maxInventory } = this.params;
    const position = this.position;
    if (!(flattenAt > 0) || Math.abs(position) < flattenAt) return;
    const lot = this.book.instrument.lotSize;
    const excess =
      Math.abs(position) - Math.min(maxInventory || flattenAt / 2, flattenAt);
    const size = roundToLot(excess, lot);
    if (size >= lot)
      this.port.market({
        side: position > 0 ? BookSide.SELL : BookSide.BUY,
        size,
      });
  }

  /** `ctx.rate`: discretionary cancel/replace events per second for this MM. */
  step({ dt, now, rate, signals }: BotStepContext) {
    const book = this.book;
    const { pullMoveBps, cooldownSecs, maxInventory } = this.params;
    // not again until it has requoted wide for a cooldown (a thin book swings)
    if (
      pullMoveBps > 0 &&
      now >= this.#wideUntil &&
      Math.abs(signals.returnBps(0)) > pullMoveBps
    ) {
      this.pull();
      this.#pulledUntil = now + cooldownSecs * 1000;
      this.#wideUntil = this.#pulledUntil + cooldownSecs * 1000;
    }
    const reference = this.#updateEstimate(dt, signals.imbalance);
    if (this.isPulled(now)) return;
    this.#flatten();
    const widen = this.#widenFor(signals.stress, now);
    if (widen !== this.#widen) {
      this.#widen = widen;
      this.#stale = true;
    }
    const position = this.position;
    const skipBuy = maxInventory > 0 && position >= maxInventory;
    const skipSell = maxInventory > 0 && position <= -maxInventory;
    if (skipBuy !== this.#skipBuy || skipSell !== this.#skipSell) {
      this.#skipBuy = skipBuy;
      this.#skipSell = skipSell;
      this.#stale = true;
    }
    const centre = stepTicks(
      roundToTick(model(book).clampToBand(reference), book.schedule),
      book.schedule,
      this.skewTicks(),
    );
    if (centre !== this.#lastCentre || this.#stale) {
      const movingUp = !(centre < this.#lastCentre);
      this.#lastCentre = centre;
      this.#stale = false;
      // reprice the side moving away from the market first to avoid self-crossing
      if (movingUp) {
        this.#reconcile(BookSide.SELL, centre);
        this.#reconcile(BookSide.BUY, centre);
      } else {
        this.#reconcile(BookSide.BUY, centre);
        this.#reconcile(BookSide.SELL, centre);
      }
    }
    const churn = this.rng.poisson(rate * dt);
    for (let i = 0; i < churn && this.#quotes.size > 0; i++) this.#churnOne();
  }

  /** Cancel all resting quotes. */
  pull() {
    this.port.pullAll();
    this.#quotes.clear();
    this.#lastCentre = Number.NaN;
  }

  targetPrices(side: BookSide, centre: number): number[] {
    if (side === BookSide.BUY ? this.#skipBuy : this.#skipSell) return [];
    const { levels, spacingTicks } = this.params;
    const halfSpreadTicks = this.halfSpread;
    const { schedule, model } = this.book;
    const dir = side === BookSide.BUY ? -1 : 1;
    const prices: number[] = [];
    // Anchor the ladder to a grid of `spacingTicks` so that a one-tick move
    // of the centre shifts at most one level per side.
    const inside = stepTicks(centre, schedule, dir * halfSpreadTicks);
    const grid = spacingTicks * tickSizeAt(schedule, inside);
    const snap = side === BookSide.BUY ? Math.floor : Math.ceil;
    let price = roundToTick(
      snap(inside / grid - dir * 1e-9) * grid,
      schedule,
      side === BookSide.BUY ? "down" : "up",
    );
    for (let level = 0; level < levels; level++) {
      if (price > 0 && model.isWithinBand(price)) prices.push(price);
      price = stepTicks(price, schedule, dir * spacingTicks);
    }
    return prices;
  }

  #levelSize(level: number) {
    const { baseQty } = this.params;
    const lot = this.book.instrument.lotSize;
    const size =
      ((baseQty * (1 + 0.5 * level)) / this.#widen) *
      this.rng.uniform(0.6, 1.4);
    return Math.max(lot, roundToLot(size, lot));
  }

  #reconcile(side: BookSide, centre: number) {
    const targets = this.targetPrices(side, centre);
    const wanted = new Map<number, number>();
    for (const [level, price] of targets.entries()) wanted.set(price, level);
    const stale: Quote[] = [];
    for (const quote of this.#quotes.values()) {
      if (quote.side !== side) continue;
      const level = wanted.get(quote.price);
      if (level === undefined) {
        stale.push(quote);
      } else {
        wanted.delete(quote.price);
        if (quote.size < quote.targetSize * 0.5) this.#topUp(quote);
      }
    }
    for (const [price, level] of wanted) {
      const size = this.#levelSize(level);
      const quote = stale.pop();
      if (quote) {
        this.#replace(quote, price, size);
      } else {
        this.#place(side, price, size);
      }
    }
    for (const quote of stale) {
      this.port.cancel(quote.id);
      this.#quotes.delete(quote.id);
    }
  }

  #place(side: BookSide, price: number, size: number) {
    const id = this.port.nextId();
    const quote: Quote = { id, side, price, size, targetSize: size };
    // registered first: the order can trade (and fill) as it is placed
    this.#quotes.set(id, quote);
    this.port.limit({ side, size, price }, id);
    if (!this.port.isResting(id)) this.#quotes.delete(id);
  }

  #replace(quote: Quote, price: number, size: number) {
    quote.price = price;
    quote.size = size;
    quote.targetSize = size;
    if (!this.port.modify(quote.id, { price, size })) {
      this.#quotes.delete(quote.id);
    }
  }

  #topUp(quote: Quote) {
    quote.size = quote.targetSize;
    this.port.modify(quote.id, { size: quote.targetSize });
  }

  /** Discretionary cancel + re-add at the same price with a fresh size. */
  #churnOne() {
    let n = this.rng.int(0, this.#quotes.size - 1);
    for (const quote of this.#quotes.values()) {
      if (n-- > 0) continue;
      this.port.cancel(quote.id);
      this.#quotes.delete(quote.id);
      const level = this.rng.int(0, this.params.levels - 1);
      this.#place(quote.side, quote.price, this.#levelSize(level));
      return;
    }
  }
}

const model = (book: InstrumentBook) => book.model;

export const MARKET_MAKER: BotKindDef = Object.freeze({
  kind: BotKind.MarketMaker,
  stage: "quote",
  rateGroup: BotType.MarketMaker,
  idPrefix: "M",
  localId: (n: number) => `MM${n}`,
  account: (n: number) => `MM${n}`,
  paramSpec: Object.freeze([
    {
      name: "levels",
      type: "integer",
      description: "Quote levels each side",
      min: 1,
      max: 20,
    },
    {
      name: "halfSpreadTicks",
      type: "integer",
      description: "Ticks from the (skewed) centre to the best quote",
      min: 1,
      unit: "ticks",
    },
    {
      name: "spacingTicks",
      type: "integer",
      description: "Ticks between quote levels",
      min: 1,
      unit: "ticks",
    },
    {
      name: "baseQty",
      type: "number",
      description: "Typical size of the best level",
      min: 0,
      unit: "shares",
    },
    {
      name: "fairHalfLifeSecs",
      type: "number",
      description:
        "Lag of the maker's fair-value estimate, as a half-life (0 = quotes on fair value)",
      min: 0,
      unit: "s",
    },
    {
      name: "flowSensitivityBps",
      type: "number",
      description:
        "Estimate shift per unit of trade imbalance (-1 all selling .. +1 all buying)",
      unit: "bps",
    },
    {
      name: "volSensitivity",
      type: "number",
      description:
        "Spread widening per unit of realised over the instrument's normal volatility above 1 (size shrinks to match; 0 = off)",
      min: 0,
    },
    {
      name: "maxWiden",
      type: "number",
      description: "Widest spread as a multiple of normal",
      min: 1,
      max: 20,
    },
    {
      name: "maxInventory",
      type: "number",
      description:
        "Stop quoting the side that adds to the position beyond this (0 = off)",
      min: 0,
      unit: "shares",
    },
    {
      name: "flattenAt",
      type: "number",
      description:
        "Market order back to maxInventory when the position passes this (0 = off)",
      min: 0,
      unit: "shares",
    },
    {
      name: "pullMoveBps",
      type: "number",
      description:
        "Pull all quotes when mid jumps this far from its 1s average (0 = off)",
      min: 0,
      unit: "bps",
    },
    {
      name: "cooldownSecs",
      type: "number",
      description:
        "After a pull: this long without quotes, then as long at twice the spread",
      min: 0,
      unit: "s",
    },
  ] as const),
  create({ localId, book, port, rng, baseQty, params = {} }: BotCreateOptions) {
    const { refPrice, tickSize } = book.instrument;
    const tickBps = (tickSize / refPrice) * 1e4;
    const ticksFor = (bps: number) => Math.max(1, Math.round(bps / tickBps));
    // drawn from the bot's own generator, so other bots don't shift them
    const halfSpreadTicks = ticksFor(rng.uniform(2, 6));
    const spacingTicks = ticksFor(rng.uniform(1, 3));
    return new MarketMaker(
      localId,
      {
        levels: num(params.levels, 5),
        halfSpreadTicks: num(params.halfSpreadTicks, halfSpreadTicks),
        spacingTicks: num(params.spacingTicks, spacingTicks),
        baseQty: num(params.baseQty, baseQty),
        fairHalfLifeSecs: num(
          params.fairHalfLifeSecs,
          MM_STRESS_DEFAULTS.fairHalfLifeSecs,
        ),
        flowSensitivityBps: num(
          params.flowSensitivityBps,
          MM_STRESS_DEFAULTS.flowSensitivityBps,
        ),
        volSensitivity: num(
          params.volSensitivity,
          MM_STRESS_DEFAULTS.volSensitivity,
        ),
        maxWiden: num(params.maxWiden, MM_STRESS_DEFAULTS.maxWiden),
        maxInventory: num(params.maxInventory, MM_STRESS_DEFAULTS.maxInventory),
        flattenAt: num(params.flattenAt, MM_STRESS_DEFAULTS.flattenAt),
        pullMoveBps: num(params.pullMoveBps, MM_STRESS_DEFAULTS.pullMoveBps),
        cooldownSecs: num(params.cooldownSecs, MM_STRESS_DEFAULTS.cooldownSecs),
      },
      port,
      rng,
    );
  },
});
