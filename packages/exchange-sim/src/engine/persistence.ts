import type { OrderBookOptions } from "@heswell/hft-limit-order-book";
import type { TradingPhase } from "@heswell/trading-schemas";
import type { GatewayState } from "../gateway/SimExchangeGateway";
import type { ExecutionReport } from "../gateway/types";
import type { SessionStats } from "./InstrumentBook";
import type { SessionPhase } from "./TradingSession";

/** hft-limit-order-book does not export `Snapshot` / `ILimitOrder` (trader upstream issue 93). */
export type BookSnapshot = NonNullable<OrderBookOptions["snapshot"]>;
export type ILimitOrder = BookSnapshot["bids"][number]["orders"][number];

/** Trade ids are reserved in blocks so none is reused after a crash. */
export const TRADE_ID_BLOCK = 1_000;

export interface ForcedPhase {
  phase: SessionPhase;
  until: number | undefined;
}

export interface BookSettings {
  ric: string;
  phase: TradingPhase;
  haltReason: string;
  volatility: number;
  mmRate: number;
  takerRate: number;
}

export interface BookState extends BookSettings {
  fair: number;
  stats: SessionStats;
  seq: number;
  /** Resting gateway (OMS) orders, bids then asks, each level in time priority. */
  orders: ILimitOrder[];
}

/**
 * Exchange snapshot. Only customer (gateway) orders are persisted: bot
 * liquidity is ephemeral and re-quoted around the restored fair value.
 */
export interface ExchangeState {
  version: 1;
  tradeSeq: number;
  marketPhase: SessionPhase;
  forced?: ForcedPhase;
  gateway: GatewayState;
  books: BookState[];
}

/** Exchange journal entries (stream "exchange"). */
export type ExchangeJournalEntry =
  /** Every gateway execution report, before the OMS sees it. */
  | { k: "report"; r: ExecutionReport }
  /** Trade ids up to `upTo` may have been issued. */
  | { k: "tradeSeq"; upTo: number }
  /** Admin change to a book (halt / resume / volatility / bot rates). */
  | { k: "book"; b: BookSettings }
  /** Market-wide phase change or setMarketPhase override. */
  | { k: "session"; marketPhase: SessionPhase; forced?: ForcedPhase };

export type ExchangeJournal = (entry: ExchangeJournalEntry) => void;

export interface ExchangeRestoreResult {
  /** Live gateway orders put back in the books. */
  restoredOrders: number;
  /** Live orders whose instrument is no longer simulated (expired). */
  droppedOrders: string[];
  tradeSeq: number;
}
