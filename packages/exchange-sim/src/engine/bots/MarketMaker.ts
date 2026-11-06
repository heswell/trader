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
import type { OrderPort } from "./OrderPort";

export type MarketMakerParams = {
  readonly levels: number;
  /** Distance from (skewed) fair value to the best quote. */
  readonly halfSpreadTicks: number;
  /** Distance between quote levels. */
  readonly spacingTicks: number;
  /** Typical size of the best level. */
  readonly baseQty: number;
};

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

  constructor(
    readonly localId: string,
    readonly params: MarketMakerParams,
    readonly port: OrderPort,
    private readonly rng: Random,
  ) {
    this.id = port.botId;
    this.account = port.account;
    port.setFillListener((orderId, trade) => this.#onFill(orderId, trade));
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

  /** Inventory skew of the quote centre, in ticks (bounded so MMs don't cross each other). */
  skewTicks() {
    const { baseQty, halfSpreadTicks } = this.params;
    const max = Math.max(0, halfSpreadTicks - 1);
    const raw = Math.round(-this.position / (baseQty * 4));
    return Math.max(-max, Math.min(max, raw));
  }

  extraStats() {
    return {
      skewTicks: this.skewTicks(),
      quotes: this.#quotes.size,
    };
  }

  /** `ctx.rate`: discretionary cancel/replace events per second for this MM. */
  step({ dt, rate }: BotStepContext) {
    const book = this.book;
    const centre = stepTicks(
      book.model.fairOnTick,
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
    const { levels, halfSpreadTicks, spacingTicks } = this.params;
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
    const size = baseQty * (1 + 0.5 * level) * this.rng.uniform(0.6, 1.4);
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

const num = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

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
      },
      port,
      rng,
    );
  },
});
