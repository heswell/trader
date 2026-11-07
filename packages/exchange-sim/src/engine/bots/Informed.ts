import {
  Side as BookSide,
  TimeInForce as BookTif,
} from "@heswell/hft-limit-order-book";
import { roundToLot, roundToTick } from "@heswell/trading-schemas";
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
import { LIMIT_SPECS, num, specs } from "./common";
import type { OrderPort } from "./OrderPort";

/**
 * Knows the true fair value. While armed (`arm(until)`, which
 * shiftFairValue with informedSecs does; or always with `alwaysOn`) it
 * buys when mid is more than `thresholdBps` under fair value and sells when
 * above, with IOCs priced no worse than fair value, so it trades only while
 * the makers' estimate lags. Unwinds its position when disarmed.
 */
export class Informed implements Bot {
  readonly kind = BotKind.Informed;
  readonly id: string;
  readonly account: string;
  #armedUntil = 0;
  #nextCheck = 0;

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

  /** Trade on the gap until clock time `until`. */
  arm(until: number) {
    this.#armedUntil = Math.max(this.#armedUntil, until);
    this.#nextCheck = 0;
  }

  armed(now: number) {
    return this.params.alwaysOn === true || now < this.#armedUntil;
  }

  extraStats() {
    return { armedUntil: this.#armedUntil };
  }

  step({ now }: BotStepContext) {
    if (now < this.#nextCheck) return;
    this.#nextCheck =
      now +
      num(this.params.checkSecs, 0.25) * 1000 * this.rng.uniform(0.8, 1.2);
    const { book } = this;
    const lot = book.instrument.lotSize;
    const top = book.topOfBook();
    const position = this.port.ledger.position;
    const clip = Math.max(lot, roundToLot(num(this.params.clipQty, lot), lot));
    if (!this.armed(now)) {
      // unwind at the touch when the edge has gone
      if (position !== 0) {
        const side = position > 0 ? BookSide.SELL : BookSide.BUY;
        const opposite = side === BookSide.BUY ? top.ask : top.bid;
        if (opposite > 0)
          this.port.market({ side, size: Math.min(Math.abs(position), clip) });
      }
      return;
    }
    if (!(top.bid > 0 && top.ask > 0)) return;
    const fair = book.model.fairValue;
    const threshold = num(this.params.thresholdBps, 5) / 1e4;
    const maxQty = num(this.params.maxQty, Number.POSITIVE_INFINITY);
    if (top.ask < fair * (1 - threshold) && position < maxQty) {
      const price = roundToTick(fair * (1 - threshold), book.schedule, "down");
      this.port.limit({
        side: BookSide.BUY,
        size: clip,
        price,
        timeInForce: BookTif.IOC,
      });
    } else if (top.bid > fair * (1 + threshold) && position > -maxQty) {
      const price = roundToTick(fair * (1 + threshold), book.schedule, "up");
      this.port.limit({
        side: BookSide.SELL,
        size: clip,
        price,
        timeInForce: BookTif.IOC,
      });
    }
  }

  pull() {}
}

export const INFORMED: BotKindDef = Object.freeze({
  kind: BotKind.Informed,
  stage: "take",
  idPrefix: "IN",
  localId: (n: number) => `INF${n}`,
  account: (n: number) => `INF${n}`,
  limits: true,
  description:
    "Trades towards the true fair value after news, while the makers lag",
  paramSpec: specs([
    {
      name: "thresholdBps",
      type: "number",
      description: "Trade when the touch is this far through fair value",
      min: 0,
      unit: "bps",
    },
    {
      name: "clipQty",
      type: "number",
      description: "Size of each IOC",
      min: 0,
      unit: "shares",
    },
    {
      name: "maxQty",
      type: "number",
      description: "Largest position",
      min: 0,
      unit: "shares",
    },
    {
      name: "checkSecs",
      type: "number",
      description: "Seconds between orders",
      min: 0.05,
      unit: "s",
    },
    {
      name: "alwaysOn",
      type: "boolean",
      description:
        "Trade on any gap, not only after shiftFairValue with informedSecs",
    },
    ...LIMIT_SPECS,
  ]),
  create({ localId, book, port, rng, baseQty, params = {} }: BotCreateOptions) {
    const lot = book.instrument.lotSize;
    return new Informed(
      localId,
      {
        thresholdBps: num(params.thresholdBps, 5),
        clipQty: num(
          params.clipQty,
          Math.max(lot, roundToLot(baseQty * 2, lot)),
        ),
        maxQty: num(params.maxQty, roundToLot(baseQty * 40, lot)),
        checkSecs: num(params.checkSecs, 0.25),
        alwaysOn: params.alwaysOn === true,
        maxPositionUsd: num(params.maxPositionUsd, 0),
        maxOrdersPerSec: num(params.maxOrdersPerSec, 0),
      },
      port,
      rng,
    );
  },
});
