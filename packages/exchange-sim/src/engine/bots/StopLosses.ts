import { Side as BookSide } from "@heswell/hft-limit-order-book";
import { roundToLot } from "@heswell/trading-schemas";
import type { Random } from "../../util/random";
import type { InstrumentBook } from "../InstrumentBook";
import {
  type Bot,
  type BotCreateOptions,
  BotKind,
  type BotKindDef,
  type BotParams,
  type BotStepContext,
} from "./Bot";
import { num, specs } from "./common";
import type { OrderPort } from "./OrderPort";

interface Stop {
  side: BookSide;
  trigger: number;
  size: number;
}

/**
 * A population of stop-loss orders around the price: sells below (longs
 * protecting gains), buys above (shorts). Held by the bot, not the book:
 * when the price (mid, or the last trade) reaches a stop's trigger it sends
 * a market order. With impact, triggered stops move the price into the
 * next ones: a cascade. Every `refreshSecs`, stops that have drifted out of
 * range are replaced around the current price; fired stops are replaced
 * only then, so a cascade uses up the population.
 */
export class StopLosses implements Bot {
  readonly kind = BotKind.StopLosses;
  readonly id: string;
  readonly account: string;
  readonly stops: Stop[] = [];
  #nextRefresh = 0;
  fired = 0;

  constructor(
    readonly localId: string,
    public params: BotParams,
    readonly port: OrderPort,
    private readonly rng: Random,
  ) {
    this.id = port.botId;
    this.account = port.account;
  }

  get book(): InstrumentBook {
    return this.port.book;
  }

  extraStats() {
    return { stops: this.stops.length, fired: this.fired };
  }

  onParamsChanged() {
    this.stops.length = 0;
    this.#nextRefresh = 0;
  }

  /** A trigger price `bps` from `price`, snapped to a round number with `clustering` probability. */
  #trigger(price: number, bps: number) {
    let trigger = price * (1 + bps / 1e4);
    if (this.rng.chance(num(this.params.clustering, 0.4))) {
      // the nearest "round" level: 1, 2 or 5 times a power of ten, about 0.5% of the price
      const exp = 10 ** Math.floor(Math.log10(price * 0.005));
      const grid =
        [1, 2, 5].map((m) => m * exp).find((g) => g >= price * 0.002) ??
        exp * 10;
      trigger = Math.round(trigger / grid) * grid;
    }
    return trigger;
  }

  #refresh(price: number) {
    const p = this.params;
    const minBps = num(p.minBps, 20);
    const maxBps = Math.max(minBps, num(p.maxBps, 200));
    const perSide = Math.round(num(p.perSide, 20));
    const meanQty = num(p.meanQty, 0);
    const lot = this.book.instrument.lotSize;
    // drop stops now out of range (the price moved away)
    for (let i = this.stops.length - 1; i >= 0; i--) {
      const s = this.stops[i];
      const bps = Math.abs((s.trigger - price) / price) * 1e4;
      const wrongSide =
        s.side === BookSide.SELL ? s.trigger >= price : s.trigger <= price;
      if (bps > maxBps * 1.5 || wrongSide) this.stops.splice(i, 1);
    }
    for (const side of [BookSide.SELL, BookSide.BUY]) {
      let count = this.stops.filter((s) => s.side === side).length;
      const dir = side === BookSide.SELL ? -1 : 1;
      while (count < perSide) {
        const bps = dir * this.rng.uniform(minBps, maxBps);
        const size = Math.max(
          lot,
          roundToLot(this.rng.exponential(meanQty), lot),
        );
        this.stops.push({ side, trigger: this.#trigger(price, bps), size });
        count++;
      }
    }
  }

  step({ now, signals }: BotStepContext) {
    const price = signals.price;
    if (!(price > 0)) return;
    if (now >= this.#nextRefresh) {
      this.#refresh(price);
      this.#nextRefresh = now + num(this.params.refreshSecs, 30) * 1000;
    }
    const top = this.book.topOfBook();
    const last = signals.lastTradePrice > 0 ? signals.lastTradePrice : price;
    for (let i = this.stops.length - 1; i >= 0; i--) {
      const s = this.stops[i];
      const hit =
        s.side === BookSide.SELL
          ? Math.min(price, last) <= s.trigger
          : Math.max(price, last) >= s.trigger;
      if (!hit) continue;
      this.stops.splice(i, 1);
      const opposite = s.side === BookSide.SELL ? top.bid : top.ask;
      if (!(opposite > 0)) continue;
      this.port.market({ side: s.side, size: s.size });
      this.fired++;
    }
  }

  pull() {}
}

export const STOP_LOSSES: BotKindDef = Object.freeze({
  kind: BotKind.StopLosses,
  stage: "take",
  idPrefix: "SL",
  localId: (n: number) => `STOPS${n}`,
  account: (n: number) => `STOPS${n}`,
  description:
    "Stop-loss orders around the price that fire as market orders (cascades)",
  paramSpec: specs([
    {
      name: "perSide",
      type: "integer",
      description: "Stops on each side of the price",
      min: 0,
      max: 500,
    },
    {
      name: "minBps",
      type: "number",
      description: "Nearest trigger distance",
      min: 0,
      unit: "bps",
    },
    {
      name: "maxBps",
      type: "number",
      description: "Furthest trigger distance",
      min: 0,
      unit: "bps",
    },
    {
      name: "meanQty",
      type: "number",
      description: "Mean size of a stop",
      min: 0,
      unit: "shares",
    },
    {
      name: "clustering",
      type: "number",
      description: "Share of triggers on round numbers",
      min: 0,
      max: 1,
    },
    {
      name: "refreshSecs",
      type: "number",
      description: "Seconds between top-ups of the population",
      min: 1,
      unit: "s",
    },
  ]),
  create({ localId, port, rng, baseQty, params = {} }: BotCreateOptions) {
    return new StopLosses(
      localId,
      {
        perSide: num(params.perSide, 20),
        minBps: num(params.minBps, 20),
        maxBps: num(params.maxBps, 200),
        meanQty: num(params.meanQty, baseQty * 2),
        clustering: num(params.clustering, 0.4),
        refreshSecs: num(params.refreshSecs, 30),
      },
      port,
      rng,
    );
  },
});
