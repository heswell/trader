import {
  Side as BookSide,
  TimeInForce as BookTif,
} from "@heswell/hft-limit-order-book";
import { roundToLot, stepTicks } from "@heswell/trading-schemas";
import type { Random } from "../../util/random";
import type { InstrumentBook } from "../InstrumentBook";

export const TAKER_OWNER = "bot:taker";

export interface NoiseTakerParams {
  /** Accounts the orders are spread across (e.g. TAKER1..TAKER3). */
  accounts: readonly string[];
  /** Mean order size. */
  baseQty: number;
  /** Mean lifetime of passive noise orders (ms). */
  passiveLifetimeMs: number;
}

/** Order mix; cumulative thresholds over a uniform draw. */
export const TAKER_MIX = Object.freeze({
  sweep: 0.02,
  market: 0.6,
  aggressiveLimit: 0.88,
  // remainder: passive noise limit order
});

let nextTakerId = 0;

/**
 * Poisson stream of liquidity-taking orders: market orders, aggressive IOC
 * limits, occasional multi-level sweeps and short-lived passive noise
 * orders. The buy/sell mix leans towards fair value so prices track the
 * model.
 */
export class NoiseTaker {
  readonly #passive: { id: string; expiresAt: number }[] = [];
  ordersSent = 0;

  constructor(
    readonly params: NoiseTakerParams,
    private readonly book: InstrumentBook,
    private readonly rng: Random,
  ) {}

  get passiveCount() {
    return this.#passive.length;
  }

  /** @param rate orders per second */
  step(dtSeconds: number, rate: number, now: number) {
    this.#expirePassive(now);
    const n = this.rng.poisson(rate * dtSeconds);
    for (let i = 0; i < n; i++) this.sendOne(now);
  }

  pull() {
    for (const { id } of this.#passive) this.book.cancel(id);
    this.#passive.length = 0;
  }

  sendOne(now: number) {
    const { book, rng } = this;
    const { lotSize } = book.instrument;
    const { schedule, model } = book;
    const top = book.topOfBook();
    const side = this.#pickSide(top.bid, top.ask);
    const opposite = side === BookSide.BUY ? top.ask : top.bid;
    const account = rng.pick(this.params.accounts);
    const id = `T${++nextTakerId}`;
    const size = Math.max(
      lotSize,
      roundToLot(rng.exponential(this.params.baseQty), lotSize),
    );
    const base = { id, side, accountId: account, owner: TAKER_OWNER };
    const dir = side === BookSide.BUY ? 1 : -1;
    const u = rng.next();
    this.ordersSent++;

    if (u < TAKER_MIX.sweep && opposite > 0) {
      const levels = rng.int(3, 5);
      const [asks, bids] = book.book.depthDetailed(levels);
      const ladder = side === BookSide.BUY ? asks : bids;
      const sweepSize = ladder.reduce((sum, level) => sum + level.size, 0);
      const limit = ladder[ladder.length - 1].price;
      book.limit({
        ...base,
        size: Math.max(size, sweepSize),
        price: limit,
        timeInForce: BookTif.IOC,
      });
    } else if (u < TAKER_MIX.market) {
      if (opposite > 0) book.market({ ...base, size });
    } else if (u < TAKER_MIX.aggressiveLimit) {
      if (opposite > 0) {
        const price = model.clampToBand(
          stepTicks(opposite, schedule, dir * rng.int(0, 2)),
        );
        book.limit({ ...base, size, price, timeInForce: BookTif.IOC });
      }
    } else {
      const reference =
        (side === BookSide.BUY ? top.bid : top.ask) || model.fairOnTick;
      const price = stepTicks(reference, schedule, -dir * rng.int(0, 5));
      if (price > 0 && model.isWithinBand(price)) {
        book.limit({ ...base, size, price });
        if (book.book.order(id)) {
          this.#passive.push({
            id,
            expiresAt: now + rng.exponential(this.params.passiveLifetimeMs),
          });
        }
      }
    }
  }

  #pickSide(bid: number, ask: number) {
    const fair = this.book.model.fairValue;
    let pBuy = 0.5;
    if (bid > 0 && ask > 0) {
      const mid = (bid + ask) / 2;
      const spread = Math.max(ask - bid, Number.EPSILON);
      pBuy += Math.max(-0.35, Math.min(0.35, ((fair - mid) / spread) * 0.5));
    }
    return this.rng.chance(pBuy) ? BookSide.BUY : BookSide.SELL;
  }

  #expirePassive(now: number) {
    const passive = this.#passive;
    let kept = 0;
    for (let i = 0; i < passive.length; i++) {
      const order = passive[i];
      if (order.expiresAt <= now) {
        this.book.cancel(order.id);
      } else if (this.book.book.order(order.id)) {
        passive[kept++] = order;
      }
    }
    passive.length = kept;
  }
}
