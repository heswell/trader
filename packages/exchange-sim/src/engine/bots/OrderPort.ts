import {
  Side as BookSide,
  type LimitOrderOptions,
  type MarketOrderOptions,
  type OrderUpdate,
  type Trade,
} from "@heswell/hft-limit-order-book";
import type { FillSink, InstrumentBook } from "../InstrumentBook";
import { BotLedger } from "./BotLedger";

/** Order owner stamped on every bot order: `bot:<ric>/<local id>`. */
export const BOT_OWNER_PREFIX = "bot:";

export const botOwner = (botId: string) => `${BOT_OWNER_PREFIX}${botId}`;

export const isBotOwner = (owner: unknown): owner is string =>
  typeof owner === "string" && owner.startsWith(BOT_OWNER_PREFIX);

/** A limit order as a bot sends it: the port adds id, account and owner. */
export type BotLimitOrder = Omit<
  LimitOrderOptions,
  "id" | "accountId" | "owner"
>;

export type BotMarketOrder = Omit<
  MarketOrderOptions,
  "id" | "accountId" | "owner"
>;

/** Receives fills for the port's orders, after the ledger has recorded them. */
export type BotFillListener = (
  orderId: string,
  trade: Trade,
  isMaker: boolean,
) => void;

/** Order ids are unique per prefix across every simulator in the process. */
const nextIds = new Map<string, number>();

/**
 * A bot's only way into its instrument's book. Stamps account and owner on
 * every order, counts orders / modifies / cancels, receives every fill (it
 * is the FillSink for all the bot's orders), records it in the ledger and
 * then passes it on. Also tracks the bot's resting orders, so `pullAll()`
 * and the resting stats work for any bot kind.
 */
export class OrderPort implements FillSink {
  readonly ledger = new BotLedger();
  readonly owner: string;
  readonly #resting = new Set<string>();
  #listener: BotFillListener | undefined;
  /** A paused bot is not stepped (pauseBots); its quotes are pulled. */
  paused = false;

  constructor(
    readonly book: InstrumentBook,
    readonly botId: string,
    readonly account: string,
    readonly idPrefix: string,
  ) {
    this.owner = botOwner(botId);
  }

  /** Where fills go after the ledger (the bot). */
  setFillListener(listener: BotFillListener | undefined) {
    this.#listener = listener;
  }

  nextId() {
    const n = (nextIds.get(this.idPrefix) ?? 0) + 1;
    nextIds.set(this.idPrefix, n);
    return `${this.idPrefix}${n}`;
  }

  /** Send a limit order; returns its id. Check `isResting(id)` for what is left. */
  limit(order: BotLimitOrder, id = this.nextId()) {
    this.ledger.orders++;
    this.book.limit(
      { ...order, id, accountId: this.account, owner: this.owner },
      this,
    );
    if (this.book.book.order(id)) this.#resting.add(id);
    return id;
  }

  market(order: BotMarketOrder, id = this.nextId()) {
    this.ledger.orders++;
    this.book.market(
      { ...order, id, accountId: this.account, owner: this.owner },
      this,
    );
    return id;
  }

  /** Amend a resting order; returns false if it is no longer in the book. */
  modify(id: string, update: OrderUpdate) {
    this.ledger.modifies++;
    this.book.modify(id, update);
    if (this.book.book.order(id)) return true;
    this.#resting.delete(id);
    return false;
  }

  cancel(id: string) {
    this.ledger.cancels++;
    this.#resting.delete(id);
    return this.book.cancel(id);
  }

  /** Cancel every resting order of this bot. */
  pullAll() {
    for (const id of [...this.#resting]) this.cancel(id);
  }

  isResting(id: string) {
    return this.#resting.has(id);
  }

  get restingCount() {
    return this.#resting.size;
  }

  /** Resting quantity per side, read from the book. */
  restingQty() {
    let bid = 0;
    let ask = 0;
    for (const id of this.#resting) {
      const order = this.book.book.order(id);
      if (!order) continue;
      if (order.side === BookSide.BUY) bid += order.size;
      else ask += order.size;
    }
    return { bid, ask };
  }

  onFill(orderId: string, trade: Trade, isMaker: boolean) {
    this.ledger.recordFill(trade, isMaker);
    if (!this.book.book.order(orderId)) this.#resting.delete(orderId);
    this.#listener?.(orderId, trade, isMaker);
  }
}
