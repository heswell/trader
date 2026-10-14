import type { DepthLevel } from "@heswell/hft-limit-order-book";
import {
  depth as depthDef,
  depthKey,
  instruments as instrumentsDef,
  prices as pricesDef,
  Side,
  type TableDefinition,
  TradingPhase,
  trades as tradesDef,
} from "@heswell/trading-schemas";
import type { InstrumentBook } from "../engine/InstrumentBook";
import type { InstrumentDef } from "../reference/instruments";
import { TradeRingBuffer } from "./TradeRingBuffer";

/** null = no value (no quote / no trade yet), rendered empty by the UI. */
export type RowValue = string | number | boolean | null;

/** Structural subset of a vuu-table Table used for publishing. */
export interface PublishTable {
  readonly columnMap: Record<string, number>;
  readonly columns: readonly unknown[];
  insert(row: RowValue[]): unknown;
  update(rowIdx: number, row: RowValue[]): unknown;
  delete(key: string): boolean;
  rowIndexAtKey(key: string): number;
}

export interface ExchangeTables {
  instruments: PublishTable;
  prices: PublishTable;
  depth: PublishTable;
  trades: PublishTable;
}

/** A trade as it appears on the public tape. */
export interface TapeTrade {
  tradeId: string;
  ric: string;
  price: number;
  size: number;
  aggressorSide: Side;
  timestamp: number;
  seq: number;
}

export interface PublisherStats {
  flushes: number;
  /** instruments + initial prices rows written at load. */
  staticRows: number;
  priceUpdates: number;
  depthUpdates: number;
  tradeInserts: number;
  tradeEvictions: number;
}

interface PublishedLevel {
  price: number;
  size: number;
  count: number;
  cum: number;
}

interface PublishedPrice {
  bid: number | null;
  ask: number | null;
  bidSize: number | null;
  askSize: number | null;
  last: number | null;
  volume: number;
  phase: string;
}

interface BookState {
  bids: PublishedLevel[];
  asks: PublishedLevel[];
  bidKeys: string[];
  askKeys: string[];
  price?: PublishedPrice;
}

const round = (value: number, decimals: number) => {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
};

class RowLayout<T extends TableDefinition> {
  readonly #template: RowValue[];
  readonly idx: Record<T["columns"][number]["name"], number>;

  /**
   * numeric: the value for numeric columns not set by the caller. Prices use
   * null (no quote or trade yet), so a LEFT JOIN or a pre-loaded row never
   * shows a fake 0 (trader upstream issue 33).
   */
  constructor(table: PublishTable, def: T, numeric: 0 | null = 0) {
    const template: RowValue[] = new Array(table.columns.length).fill(numeric);
    const idx = {} as Record<string, number>;
    for (const { name, dataType } of def.columns) {
      const i = table.columnMap[name];
      if (i === undefined) throw Error(`${def.name}: no column ${name}`);
      idx[name] = i;
      template[i] =
        dataType === "string" ? "" : dataType === "boolean" ? false : numeric;
    }
    this.#template = template;
    this.idx = idx;
  }

  row() {
    return this.#template.slice();
  }
}

/**
 * Publishes simulator state to the EXCHANGE tables. Book changes are
 * coalesced: each flush publishes the current state of every dirty book
 * once (prices row + depth delta), then appends the trades since the last
 * flush to the ring-buffered tape.
 */
export class MarketDataPublisher {
  readonly stats: PublisherStats = {
    flushes: 0,
    staticRows: 0,
    priceUpdates: 0,
    depthUpdates: 0,
    tradeInserts: 0,
    tradeEvictions: 0,
  };
  readonly #ring: TradeRingBuffer;
  readonly #pendingTrades: TapeTrade[] = [];
  readonly #books = new Map<InstrumentBook, BookState>();
  readonly #prices: RowLayout<typeof pricesDef>;
  readonly #depth: RowLayout<typeof depthDef>;
  readonly #trades: RowLayout<typeof tradesDef>;

  constructor(
    readonly tables: ExchangeTables,
    readonly depthLevels: number,
    tradesCapacity: number,
  ) {
    this.#ring = new TradeRingBuffer(tradesCapacity);
    this.#prices = new RowLayout(tables.prices, pricesDef, null);
    this.#depth = new RowLayout(tables.depth, depthDef);
    this.#trades = new RowLayout(tables.trades, tradesDef);
  }

  get tradesBuffered() {
    return this.#ring.size;
  }

  /** Static rows: every listed instrument plus an initial CLOSED prices row. */
  loadInstruments(
    all: readonly InstrumentDef[],
    isSimulated: (ric: string) => boolean,
  ) {
    const layout = new RowLayout(this.tables.instruments, instrumentsDef);
    const { idx } = layout;
    for (const instrument of all) {
      const row = layout.row();
      row[idx.ric] = instrument.ric;
      row[idx.description] = instrument.description;
      row[idx.currency] = instrument.currency;
      row[idx.exchange] = instrument.exchange;
      row[idx.sector] = instrument.sector;
      row[idx.tickSize] = instrument.tickSize;
      row[idx.tickBands] = instrument.tickBands;
      row[idx.lotSize] = instrument.lotSize;
      row[idx.priceDecimals] = instrument.priceDecimals;
      row[idx.refPrice] = instrument.refPrice;
      row[idx.simulated] = isSimulated(instrument.ric);
      this.tables.instruments.insert(row);
      // Every instrument gets a prices row up front so both tables share the
      // universe order; simulated rows are overwritten by the first flush.
      const price = this.#prices.row();
      price[this.#prices.idx.ric] = instrument.ric;
      price[this.#prices.idx.close] = instrument.refPrice;
      price[this.#prices.idx.phase] = TradingPhase.Closed;
      this.tables.prices.insert(price);
      this.stats.staticRows += 2;
    }
  }

  addTrade(trade: TapeTrade) {
    this.#pendingTrades.push(trade);
  }

  flush(books: Iterable<InstrumentBook>, now: number) {
    this.stats.flushes++;
    for (const book of books) {
      if (book.dirty) this.publishBook(book, now);
    }
    this.#publishTrades();
  }

  publishBook(book: InstrumentBook, now: number) {
    book.dirty = false;
    let state = this.#books.get(book);
    if (!state) {
      state = this.#initBook(book);
      this.#books.set(book, state);
    }
    const [asks, bids] = book.book.depthDetailed(this.depthLevels);
    this.#publishSide(book, Side.Buy, bids, state.bids, state.bidKeys);
    this.#publishSide(book, Side.Sell, asks, state.asks, state.askKeys);
    this.#publishPrice(book, state, bids[0], asks[0], now);
  }

  #initBook(book: InstrumentBook): BookState {
    const keys = (side: Side) =>
      Array.from({ length: this.depthLevels }, (_, level) =>
        depthKey(book.ric, side, level),
      );
    return {
      bids: [],
      asks: [],
      bidKeys: keys(Side.Buy),
      askKeys: keys(Side.Sell),
    };
  }

  #publishSide(
    book: InstrumentBook,
    side: Side,
    levels: DepthLevel[],
    published: PublishedLevel[],
    keys: string[],
  ) {
    const table = this.tables.depth;
    const { idx } = this.#depth;
    const seq = book.seq;
    let cum = 0;
    const n = Math.max(levels.length, published.length);
    for (let level = 0; level < n; level++) {
      const next = levels[level];
      const prev = published[level];
      if (next === undefined) {
        table.delete(keys[level]);
        this.stats.depthUpdates++;
        continue;
      }
      cum += next.size;
      if (
        prev !== undefined &&
        prev.price === next.price &&
        prev.size === next.size &&
        prev.count === next.count &&
        prev.cum === cum
      ) {
        continue;
      }
      const row = this.#depth.row();
      row[idx.id] = keys[level];
      row[idx.ric] = book.ric;
      row[idx.side] = side;
      row[idx.level] = level;
      row[idx.price] = next.price;
      row[idx.size] = next.size;
      row[idx.cumSize] = cum;
      row[idx.orderCount] = next.count;
      row[idx.seq] = seq;
      if (prev === undefined) {
        table.insert(row);
      } else {
        table.update(table.rowIndexAtKey(keys[level]), row);
      }
      this.stats.depthUpdates++;
    }
    published.length = levels.length;
    cum = 0;
    for (let level = 0; level < levels.length; level++) {
      const { price, size, count } = levels[level];
      cum += size;
      published[level] = { price, size, count, cum };
    }
  }

  #publishPrice(
    book: InstrumentBook,
    state: BookState,
    bestBid: DepthLevel | undefined,
    bestAsk: DepthLevel | undefined,
    now: number,
  ) {
    const { stats, instrument } = book;
    const next: PublishedPrice = {
      bid: bestBid?.price ?? null,
      ask: bestAsk?.price ?? null,
      bidSize: bestBid?.size ?? null,
      askSize: bestAsk?.size ?? null,
      last: stats.tradeCount ? stats.last : null,
      volume: stats.volume,
      phase: book.phase,
    };
    const prev = state.price;
    if (
      prev &&
      prev.bid === next.bid &&
      prev.ask === next.ask &&
      prev.bidSize === next.bidSize &&
      prev.askSize === next.askSize &&
      prev.last === next.last &&
      prev.volume === next.volume &&
      prev.phase === next.phase
    ) {
      return;
    }
    state.price = next;
    const decimals = instrument.priceDecimals;
    const close = instrument.refPrice;
    const traded = stats.tradeCount > 0;
    const change = traded ? round(stats.last - close, decimals) : null;
    const { idx } = this.#prices;
    const row = this.#prices.row();
    row[idx.ric] = book.ric;
    row[idx.bid] = next.bid;
    row[idx.ask] = next.ask;
    row[idx.bidSize] = next.bidSize;
    row[idx.askSize] = next.askSize;
    if (traded) {
      row[idx.last] = stats.last;
      row[idx.lastSize] = stats.lastSize;
      row[idx.open] = stats.open;
      row[idx.high] = stats.high;
      row[idx.low] = stats.low;
      row[idx.vwap] = round(stats.turnover / stats.volume, decimals + 2);
      row[idx.changePct] = round((100 * (change as number)) / close, 4);
    }
    row[idx.close] = close;
    row[idx.volume] = stats.volume;
    row[idx.turnover] = round(stats.turnover, 2);
    row[idx.change] = change;
    row[idx.phase] = book.phase;
    row[idx.seq] = book.seq;
    row[idx.timestamp] = now;
    const table = this.tables.prices;
    const rowIdx = table.rowIndexAtKey(book.ric);
    if (rowIdx === -1) table.insert(row);
    else table.update(rowIdx, row);
    this.stats.priceUpdates++;
  }

  #publishTrades() {
    const pending = this.#pendingTrades;
    if (pending.length === 0) return;
    const table = this.tables.trades;
    const { idx } = this.#trades;
    for (let i = 0; i < pending.length; i++) {
      const trade = pending[i];
      const row = this.#trades.row();
      row[idx.tradeId] = trade.tradeId;
      row[idx.ric] = trade.ric;
      row[idx.price] = trade.price;
      row[idx.size] = trade.size;
      row[idx.aggressorSide] = trade.aggressorSide;
      row[idx.timestamp] = trade.timestamp;
      row[idx.seq] = trade.seq;
      const evicted = this.#ring.push(trade.tradeId);
      if (evicted !== undefined) {
        table.delete(evicted);
        this.stats.tradeEvictions++;
      }
      table.insert(row);
      this.stats.tradeInserts++;
    }
    pending.length = 0;
  }

  /** Total rows touched, derived from the per-table counters. */
  get totalUpdates() {
    const s = this.stats;
    return (
      s.staticRows +
      s.priceUpdates +
      s.depthUpdates +
      s.tradeInserts +
      s.tradeEvictions
    );
  }
}
