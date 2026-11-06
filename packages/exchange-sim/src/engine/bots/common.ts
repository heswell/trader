import { Side as BookSide } from "@heswell/hft-limit-order-book";
import { roundToLot, Side } from "@heswell/trading-schemas";
import type { InstrumentBook } from "../InstrumentBook";
import type { BotParamSpec } from "./Bot";

/** A number param, else `fallback`. */
export const num = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/** A string param that is one of `options`, else `fallback`. */
export const pick = <T extends string>(
  value: unknown,
  options: readonly T[],
  fallback: T,
): T =>
  typeof value === "string" && (options as readonly string[]).includes(value)
    ? (value as T)
    : fallback;

export const bool = (value: unknown, fallback: boolean) =>
  typeof value === "boolean" ? value : fallback;

export const bookSide = (side: string) =>
  side === Side.Buy ? BookSide.BUY : BookSide.SELL;

/** +1 for buy, -1 for sell. */
export const sideSign = (side: BookSide) => (side === BookSide.BUY ? 1 : -1);

/** Shares worth `usd` at `price` (whole lots, at least one). */
export const qtyForUsd = (book: InstrumentBook, usd: number, price: number) => {
  const { lotSize, usdPerPriceUnit } = book.instrument;
  if (!(price > 0) || !(usd > 0)) return 0;
  return Math.max(
    lotSize,
    roundToLot(usd / (price * usdPerPriceUnit), lotSize),
  );
};

/** Whole lots of `qty` (0 when under one lot). */
export const lots = (book: InstrumentBook, qty: number) =>
  qty >= book.instrument.lotSize ? roundToLot(qty, book.instrument.lotSize) : 0;

/** Mid, or fair value when the book is one-sided. */
export const markOf = (book: InstrumentBook) => {
  const top = book.topOfBook();
  return top.bid > 0 && top.ask > 0
    ? (top.bid + top.ask) / 2
    : book.model.fairValue;
};

/** A kind's parameter specs, typed and frozen. */
export const specs = (list: BotParamSpec[]): readonly BotParamSpec[] =>
  Object.freeze(list);

/** Specs shared by the directional kinds: the order port limits. */
export const LIMIT_SPECS: readonly BotParamSpec[] = specs([
  {
    name: "maxPositionUsd",
    type: "number",
    description:
      "Position limit: beyond it the bot is pulled and paused (0 = none)",
    min: 0,
    unit: "USD",
  },
  {
    name: "maxOrdersPerSec",
    type: "number",
    description:
      "Order rate limit (orders, modifies and cancels): beyond it the bot is pulled and paused (0 = none)",
    min: 0,
    unit: "/s",
  },
]);
