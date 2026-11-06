import {
  Side as BookSide,
  TimeInForce as BookTif,
} from "@heswell/hft-limit-order-book";
import { BotType, roundToLot, stepTicks } from "@heswell/trading-schemas";
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

export type NoiseTakerParams = {
  /** Mean order size. */
  readonly baseQty: number;
  /** Mean lifetime of passive noise orders (ms). */
  readonly passiveLifetimeMs: number;
};

/** Order mix; cumulative thresholds over a uniform draw. */
export const TAKER_MIX = Object.freeze({
  sweep: 0.02,
  market: 0.6,
  aggressiveLimit: 0.88,
  // remainder: passive noise limit order
});

/** Noise takers per instrument in the default roster (one account each). */
export const DEFAULT_TAKERS = 3;

/**
 * Poisson stream of liquidity-taking orders: market orders, aggressive IOC
 * limits, occasional multi-level sweeps and short-lived passive noise
 * orders. The buy/sell mix leans towards fair value so prices track the
 * model.
 */
export class NoiseTaker implements Bot {
  readonly kind = BotKind.NoiseTaker;
  readonly id: string;
  readonly account: string;
  readonly #passive: { id: string; expiresAt: number }[] = [];

  constructor(
    readonly localId: string,
    readonly params: NoiseTakerParams,
    readonly port: OrderPort,
    private readonly rng: Random,
  ) {
    this.id = port.botId;
    this.account = port.account;
  }

  get book(): InstrumentBook {
    return this.port.book;
  }

  get passiveCount() {
    return this.#passive.length;
  }

  extraStats() {
    return { passive: this.#passive.length };
  }

  /** `ctx.rate`: orders per second for this taker. */
  step({ dt, rate, now }: BotStepContext) {
    this.#expirePassive(now);
    const n = this.rng.poisson(rate * dt);
    for (let i = 0; i < n; i++) this.sendOne(now);
  }

  pull() {
    for (const { id } of this.#passive) this.port.cancel(id);
    this.#passive.length = 0;
  }

  sendOne(now: number) {
    const { book, rng, port } = this;
    const { lotSize } = book.instrument;
    const { schedule, model } = book;
    const top = book.topOfBook();
    const side = this.#pickSide(top.bid, top.ask);
    const opposite = side === BookSide.BUY ? top.ask : top.bid;
    const size = Math.max(
      lotSize,
      roundToLot(rng.exponential(this.params.baseQty), lotSize),
    );
    const dir = side === BookSide.BUY ? 1 : -1;
    const u = rng.next();

    if (u < TAKER_MIX.sweep && opposite > 0) {
      const levels = rng.int(3, 5);
      const [asks, bids] = book.book.depthDetailed(levels);
      const ladder = side === BookSide.BUY ? asks : bids;
      const sweepSize = ladder.reduce((sum, level) => sum + level.size, 0);
      const limit = ladder[ladder.length - 1].price;
      port.limit({
        side,
        size: Math.max(size, sweepSize),
        price: limit,
        timeInForce: BookTif.IOC,
      });
    } else if (u < TAKER_MIX.market) {
      if (opposite > 0) port.market({ side, size });
    } else if (u < TAKER_MIX.aggressiveLimit) {
      if (opposite > 0) {
        const price = model.clampToBand(
          stepTicks(opposite, schedule, dir * rng.int(0, 2)),
        );
        port.limit({ side, size, price, timeInForce: BookTif.IOC });
      }
    } else {
      const reference =
        (side === BookSide.BUY ? top.bid : top.ask) || model.fairOnTick;
      const price = stepTicks(reference, schedule, -dir * rng.int(0, 5));
      if (price > 0 && model.isWithinBand(price)) {
        const id = port.limit({ side, size, price });
        if (port.isResting(id)) {
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
        this.port.cancel(order.id);
      } else if (this.port.isResting(order.id)) {
        passive[kept++] = order;
      }
    }
    passive.length = kept;
  }
}

const num = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

export const NOISE_TAKER: BotKindDef = Object.freeze({
  kind: BotKind.NoiseTaker,
  stage: "take",
  rateGroup: BotType.Taker,
  idPrefix: "T",
  localId: (n: number) => `TAKER${n}`,
  account: (n: number) => `TAKER${n}`,
  paramSpec: Object.freeze([
    {
      name: "baseQty",
      type: "number",
      description: "Mean order size",
      min: 0,
      unit: "shares",
    },
    {
      name: "passiveLifetimeMs",
      type: "number",
      description: "Mean lifetime of passive noise orders",
      min: 0,
      unit: "ms",
    },
  ] as const),
  create({ localId, book, port, rng, baseQty, params = {} }: BotCreateOptions) {
    const { lotSize } = book.instrument;
    return new NoiseTaker(
      localId,
      {
        baseQty: num(
          params.baseQty,
          Math.max(lotSize, roundToLot(baseQty * 0.6, lotSize)),
        ),
        passiveLifetimeMs: num(params.passiveLifetimeMs, 2_000),
      },
      port,
      rng,
    );
  },
});
