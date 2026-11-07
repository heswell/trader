import {
  Side as BookSide,
  TimeInForce as BookTif,
} from "@heswell/hft-limit-order-book";
import { roundToTick } from "@heswell/trading-schemas";
import type { Random } from "../../util/random";
import type { InstrumentBook } from "../InstrumentBook";
import type { Bot, BotParams, BotStepContext } from "./Bot";
import type { BotKind } from "./Bot";
import { lots } from "./common";
import type { OrderPort } from "./OrderPort";

/**
 * Base of the bots that trade towards a target position: every
 * `checkSecs` the kind picks a target, then the base works the difference
 * in clips of `clipQty` (market orders, or passive limits at the touch when
 * `passive()` says so).
 */
export abstract class DirectionalBot implements Bot {
  abstract readonly kind: BotKind;
  readonly id: string;
  readonly account: string;
  #nextCheck = 0;
  #passiveId: string | undefined;
  /** When the current position was opened (0 = flat). */
  protected openedAt = 0;
  /** Mark when the position was opened. */
  protected entryPrice = 0;

  constructor(
    readonly localId: string,
    public params: BotParams,
    readonly port: OrderPort,
    protected readonly rng: Random,
  ) {
    this.id = port.botId;
    this.account = port.account;
  }

  get book(): InstrumentBook {
    return this.port.book;
  }

  get position() {
    return this.port.ledger.position;
  }

  /** Target position now (shares, signed). */
  protected abstract target(ctx: BotStepContext): number;

  /** Work the gap with passive orders at the touch instead of market orders. */
  protected passive(_ctx: BotStepContext) {
    return false;
  }

  protected get checkSecs() {
    return Number(this.params.checkSecs) || 1;
  }

  protected get clipQty() {
    return Number(this.params.clipQty) || this.book.instrument.lotSize;
  }

  step(ctx: BotStepContext) {
    if (ctx.now < this.#nextCheck) return;
    // spread checks so bots of one kind don't act in the same step
    this.#nextCheck =
      ctx.now + this.checkSecs * 1000 * this.rng.uniform(0.8, 1.2);
    const before = this.position;
    const target = this.target(ctx);
    this.#work(target - this.position, ctx);
    const after = this.position;
    if (before === 0 && after !== 0) {
      this.openedAt = ctx.now;
      this.entryPrice = ctx.signals.price;
    } else if (after === 0) this.openedAt = 0;
  }

  #work(gap: number, ctx: BotStepContext) {
    if (this.#passiveId) {
      this.port.cancel(this.#passiveId);
      this.#passiveId = undefined;
    }
    const size = lots(this.book, Math.min(Math.abs(gap), this.clipQty));
    if (size === 0) return;
    const side = gap > 0 ? BookSide.BUY : BookSide.SELL;
    const top = this.book.topOfBook();
    if (this.passive(ctx)) {
      const touch = side === BookSide.BUY ? top.bid : top.ask;
      if (!(touch > 0) || !this.book.model.isWithinBand(touch)) return;
      const id = this.port.limit({
        side,
        size,
        price: roundToTick(touch, this.book.schedule),
      });
      if (this.port.isResting(id)) this.#passiveId = id;
      return;
    }
    const opposite = side === BookSide.BUY ? top.ask : top.bid;
    if (opposite > 0) this.port.market({ side, size });
    else if (top.bid > 0 || top.ask > 0) {
      // one-sided book: an IOC at the band edge rather than a market order into nothing
      const price =
        side === BookSide.BUY
          ? this.book.model.upperBand
          : this.book.model.lowerBand;
      this.port.limit({ side, size, price, timeInForce: BookTif.IOC });
    }
  }

  pull() {
    if (this.#passiveId) this.port.cancel(this.#passiveId);
    this.#passiveId = undefined;
  }

  onParamsChanged() {
    this.#nextCheck = 0;
  }

  extraStats() {
    return { target: this.lastTarget };
  }

  protected lastTarget = 0;
}
