import {
  Side as BookSide,
  TimeInForce as BookTif,
} from "@heswell/hft-limit-order-book";
import { Side, stepTicks, usdPerUnit } from "@heswell/trading-schemas";
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
import {
  bookSide,
  LIMIT_SPECS,
  lots,
  num,
  pick,
  qtyForUsd,
  specs,
} from "./common";
import type { OrderPort } from "./OrderPort";

export const AGGRESSIVE_STYLES = ["market", "sweep", "ioc"] as const;
const SIDES = [Side.Buy, Side.Sell] as const;

/**
 * A blunt metaorder: buys or sells `notionalUsd` evenly over `durationSecs`
 * with market orders, sweeps of the top levels or IOCs a few ticks through,
 * and stops early if the price moves `floorBps` from where it started.
 * Idle once done (a scenario removes it with its revert).
 */
export class AggressiveTrader implements Bot {
  readonly kind = BotKind.AggressiveTrader;
  readonly id: string;
  readonly account: string;
  #startedAt = 0;
  #startPrice = 0;
  #doneUsd = 0;
  #nextSlice = 0;
  #finished = false;

  constructor(
    readonly localId: string,
    public params: BotParams,
    readonly port: OrderPort,
    private readonly rng: Random,
  ) {
    this.id = port.botId;
    this.account = port.account;
    port.setFillListener((_, trade) => {
      this.#doneUsd +=
        trade.price * trade.size * usdPerUnit(this.book.instrument);
    });
  }

  get book(): InstrumentBook {
    return this.port.book;
  }

  get doneUsd() {
    return this.#doneUsd;
  }

  get finished() {
    return this.#finished;
  }

  extraStats() {
    return {
      doneUsd: Math.round(this.#doneUsd),
      finished: this.#finished ? 1 : 0,
    };
  }

  /** New params restart the order (a fresh notional over a fresh duration). */
  onParamsChanged() {
    this.#startedAt = 0;
    this.#doneUsd = 0;
    this.#finished = false;
  }

  step({ now, signals }: BotStepContext) {
    if (this.#finished || now < this.#nextSlice) return;
    const p = this.params;
    const side = bookSide(pick(p.side, SIDES, Side.Sell));
    const dir = side === BookSide.BUY ? 1 : -1;
    const price = signals.price;
    if (!(price > 0)) return;
    if (this.#startedAt === 0) {
      this.#startedAt = now;
      this.#startPrice = price;
    }
    const notional = num(p.notionalUsd, 0);
    const duration = Math.max(0.1, num(p.durationSecs, 30));
    const floor = num(p.floorBps, 0);
    const moved = ((price - this.#startPrice) / this.#startPrice) * 1e4 * dir;
    if (this.#doneUsd >= notional * 0.999 || (floor > 0 && -moved >= floor)) {
      this.#finished = true;
      return;
    }
    const sliceSecs = Math.max(0.05, num(p.sliceSecs, 0.5));
    this.#nextSlice = now + sliceSecs * 1000;
    const due =
      notional *
      Math.min(
        1,
        (now - this.#startedAt) / 1000 / duration + sliceSecs / duration,
      );
    const usd = due - this.#doneUsd;
    const size = qtyForUsd(this.book, usd, price);
    if (size === 0) return;
    const top = this.book.topOfBook();
    const opposite = side === BookSide.BUY ? top.ask : top.bid;
    const style = pick(p.style, AGGRESSIVE_STYLES, "market");
    const { model, schedule } = this.book;
    if (style === "market" && opposite > 0) {
      this.port.market({ side, size });
    } else if (style === "sweep" && opposite > 0) {
      const [asks, bids] = this.book.book.depthDetailed(5);
      const ladder = side === BookSide.BUY ? asks : bids;
      const last = ladder[ladder.length - 1]?.price ?? opposite;
      this.port.limit({ side, size, price: last, timeInForce: BookTif.IOC });
    } else {
      // ioc, or a one-sided book: a few ticks through the touch (or the last price)
      const reference = opposite > 0 ? opposite : price;
      const limit = model.clampToBand(
        stepTicks(reference, schedule, dir * this.rng.int(1, 3)),
      );
      const qty = lots(this.book, size);
      if (qty > 0)
        this.port.limit({
          side,
          size: qty,
          price: limit,
          timeInForce: BookTif.IOC,
        });
    }
  }

  pull() {
    this.port.pullAll();
  }
}

export const AGGRESSIVE_TRADER: BotKindDef = Object.freeze({
  kind: BotKind.AggressiveTrader,
  stage: "take",
  idPrefix: "AG",
  localId: (n: number) => `AGG${n}`,
  account: (n: number) => `AGG${n}`,
  limits: true,
  description:
    "Buys or sells a notional over a set time with market orders (flash crashes)",
  paramSpec: specs([
    {
      name: "side",
      type: "string",
      description: "BUY or SELL",
      options: SIDES,
    },
    {
      name: "notionalUsd",
      type: "number",
      description: "Amount to trade",
      min: 0,
      unit: "USD",
    },
    {
      name: "durationSecs",
      type: "number",
      description: "Spread over this long",
      min: 0.1,
      unit: "s",
    },
    {
      name: "style",
      type: "string",
      description:
        "market, sweep (IOC through the top 5 levels) or ioc (a few ticks through)",
      options: AGGRESSIVE_STYLES,
    },
    {
      name: "floorBps",
      type: "number",
      description:
        "Stop after the price moves this far from the start (0 = never)",
      min: 0,
      unit: "bps",
    },
    {
      name: "sliceSecs",
      type: "number",
      description: "Seconds between orders",
      min: 0.05,
      unit: "s",
    },
    ...LIMIT_SPECS,
  ]),
  create({ localId, port, rng, params = {} }: BotCreateOptions) {
    return new AggressiveTrader(
      localId,
      {
        side: pick(params.side, SIDES, Side.Sell),
        notionalUsd: num(params.notionalUsd, 2_000_000),
        durationSecs: num(params.durationSecs, 30),
        style: pick(params.style, AGGRESSIVE_STYLES, "market"),
        floorBps: num(params.floorBps, 0),
        sliceSecs: num(params.sliceSecs, 0.5),
        maxPositionUsd: num(params.maxPositionUsd, 0),
        maxOrdersPerSec: num(params.maxOrdersPerSec, 0),
      },
      port,
      rng,
    );
  },
});
