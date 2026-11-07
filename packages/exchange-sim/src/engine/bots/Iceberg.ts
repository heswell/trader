import {
  Side as BookSide,
  TimeInForce as BookTif,
} from "@heswell/hft-limit-order-book";
import {
  roundToLot,
  roundToTick,
  Side,
  stepTicks,
} from "@heswell/trading-schemas";
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
import { bookSide, num, pick, specs } from "./common";
import type { OrderPort } from "./OrderPort";

export const ICEBERG_PEGS = ["fixed", "touch", "fair"] as const;
const SIDES = [Side.Buy, Side.Sell] as const;

/**
 * A large passive order shown a slice at a time: `displayQty` of
 * `totalQty` rests; when a slice fills, the next is sent as a new order
 * (back of the queue, as on most venues). `peg`: a `fixed` price
 * (`price`, or the touch when the bot starts), the same-side `touch`, or
 * `fair` value, each `offsetTicks` away from the market. Idle once
 * `totalQty` has traded.
 */
export class Iceberg implements Bot {
  readonly kind = BotKind.Iceberg;
  readonly id: string;
  readonly account: string;
  #slice: { id: string; price: number } | undefined;
  #filled = 0;
  #fixedPrice = 0;
  refills = 0;

  constructor(
    readonly localId: string,
    public params: BotParams,
    readonly port: OrderPort,
    private readonly rng: Random,
  ) {
    this.id = port.botId;
    this.account = port.account;
    port.setFillListener((orderId, trade) => {
      this.#filled += trade.size;
      if (orderId === this.#slice?.id && !port.isResting(orderId))
        this.#slice = undefined;
    });
  }

  get book(): InstrumentBook {
    return this.port.book;
  }

  get filled() {
    return this.#filled;
  }

  get remaining() {
    return Math.max(0, num(this.params.totalQty, 0) - this.#filled);
  }

  extraStats() {
    return {
      filled: this.#filled,
      remaining: this.remaining,
      refills: this.refills,
    };
  }

  onParamsChanged() {
    this.#fixedPrice = 0;
    this.pull();
  }

  #price(side: BookSide) {
    const p = this.params;
    const { schedule, model } = this.book;
    const dir = side === BookSide.BUY ? -1 : 1;
    const offset = Math.round(num(p.offsetTicks, 0));
    const peg = pick(p.peg, ICEBERG_PEGS, "touch");
    const top = this.book.topOfBook();
    const touch = side === BookSide.BUY ? top.bid : top.ask;
    if (peg === "fixed") {
      if (!(this.#fixedPrice > 0)) {
        const given = num(p.price, 0);
        this.#fixedPrice =
          given > 0
            ? roundToTick(given, schedule)
            : touch > 0
              ? stepTicks(touch, schedule, dir * offset)
              : 0;
      }
      return this.#fixedPrice;
    }
    const base = peg === "fair" ? model.fairOnTick : touch;
    if (!(base > 0)) return 0;
    return stepTicks(base, schedule, dir * offset);
  }

  step(_ctx: BotStepContext) {
    const remaining = this.remaining;
    const lot = this.book.instrument.lotSize;
    if (remaining < lot) {
      if (this.#slice) this.pull();
      return;
    }
    const side = bookSide(pick(this.params.side, SIDES, Side.Buy));
    const price = this.#price(side);
    if (!(price > 0) || !this.book.model.isWithinBand(price)) return;
    if (this.#slice && this.#slice.price !== price) {
      // repegged: a fresh order (loses its queue place, as a re-price does)
      this.port.cancel(this.#slice.id);
      this.#slice = undefined;
    }
    if (this.#slice) return;
    const show = Math.min(remaining, num(this.params.displayQty, lot));
    // vary the slice a little, as real icebergs often do
    const size = Math.max(
      lot,
      roundToLot(show * this.rng.uniform(0.9, 1.1), lot),
    );
    const id = this.port.limit({
      side,
      size: Math.min(size, roundToLot(remaining, lot)),
      price,
      timeInForce: BookTif.GTC,
      postOnly: true,
    });
    if (this.port.isResting(id)) {
      this.#slice = { id, price };
      this.refills++;
    }
  }

  pull() {
    if (this.#slice) this.port.cancel(this.#slice.id);
    this.#slice = undefined;
  }
}

export const ICEBERG: BotKindDef = Object.freeze({
  kind: BotKind.Iceberg,
  stage: "quote",
  idPrefix: "IC",
  localId: (n: number) => `ICE${n}`,
  account: (n: number) => `ICE${n}`,
  description: "A large passive order shown a slice at a time",
  paramSpec: specs([
    {
      name: "side",
      type: "string",
      description: "BUY or SELL",
      options: SIDES,
    },
    {
      name: "totalQty",
      type: "number",
      description: "Whole order",
      min: 0,
      unit: "shares",
    },
    {
      name: "displayQty",
      type: "number",
      description: "Slice shown at a time",
      min: 0,
      unit: "shares",
    },
    {
      name: "peg",
      type: "string",
      description: "fixed, touch (same-side best) or fair",
      options: ICEBERG_PEGS,
    },
    {
      name: "offsetTicks",
      type: "integer",
      description: "Ticks behind the peg (away from the market)",
      min: 0,
      unit: "ticks",
    },
    {
      name: "price",
      type: "number",
      description: "Price for peg fixed (0 = the touch when it starts)",
      min: 0,
    },
  ]),
  create({ localId, book, port, rng, baseQty, params = {} }: BotCreateOptions) {
    const lot = book.instrument.lotSize;
    return new Iceberg(
      localId,
      {
        side: pick(params.side, SIDES, Side.Buy),
        totalQty: num(params.totalQty, roundToLot(baseQty * 50, lot)),
        displayQty: num(
          params.displayQty,
          Math.max(lot, roundToLot(baseQty, lot)),
        ),
        peg: pick(params.peg, ICEBERG_PEGS, "touch"),
        offsetTicks: num(params.offsetTicks, 0),
        price: num(params.price, 0),
      },
      port,
      rng,
    );
  },
});
