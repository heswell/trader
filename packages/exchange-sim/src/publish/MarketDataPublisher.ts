import type { DepthLevel } from "@heswell/hft-limit-order-book";
import {
  depth as depthDef,
  depthKey,
  instruments as instrumentsDef,
  prices as pricesDef,
  Side,
  TradingPhase,
  trades as tradesDef,
} from "@heswell/trading-schemas";
import type { InstrumentBook } from "../engine/InstrumentBook";
import type { InstrumentDef } from "../reference/instruments";
import { BarAggregator, type BarOptions } from "./BarAggregator";
import { BookSampler, type BookSampleOptions } from "./BookSampler";
import { type PublishTable, RowLayout, round } from "./rows";
import { TradeRingBuffer } from "./TradeRingBuffer";

export type { PublishTable, RowValue } from "./rows";

export interface ExchangeTables {
  instruments: PublishTable;
  prices: PublishTable;
  depth: PublishTable;
  trades: PublishTable;
  /** OHLCV bars; omit (or disable in options) to skip bar aggregation. */
  bars?: PublishTable;
  /** Periodic book snapshots; omit (or disable in options) to skip sampling. */
  bookSamples?: PublishTable;
}

export interface PublisherOptions {
  /** Bar aggregation (needs `tables.bars`); omit or no intervals = off. */
  bars?: BarOptions;
  /** Book sampling (needs `tables.bookSamples`); omit or intervalMs 0 = off. */
  bookSamples?: BookSampleOptions;
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
  barInserts: number;
  barUpdates: number;
  barEvictions: number;
  sampleInserts: number;
  sampleEvictions: number;
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
    barInserts: 0,
    barUpdates: 0,
    barEvictions: 0,
    sampleInserts: 0,
    sampleEvictions: 0,
  };
  /** Bar aggregation, when enabled. */
  readonly bars: BarAggregator | undefined;
  /** Book sampling, when enabled. */
  readonly bookSamples: BookSampler | undefined;
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
    options: PublisherOptions = {},
  ) {
    this.#ring = new TradeRingBuffer(tradesCapacity);
    if (tables.bars && options.bars && options.bars.intervals.length > 0) {
      this.bars = new BarAggregator(tables.bars, options.bars, this.stats);
    }
    if (
      tables.bookSamples &&
      options.bookSamples &&
      options.bookSamples.intervalMs > 0
    ) {
      this.bookSamples = new BookSampler(
        tables.bookSamples,
        options.bookSamples,
        this.stats,
      );
    }
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
    this.bars?.addTrade(trade.ric, trade.price, trade.size, trade.timestamp);
  }

  flush(books: Iterable<InstrumentBook>, now: number) {
    this.stats.flushes++;
    for (const book of books) {
      if (book.dirty) this.publishBook(book, now);
    }
    this.#publishTrades();
    this.bars?.flush(now);
    const sampler = this.bookSamples;
    if (sampler?.due(now)) {
      const time = sampler.sampleTime(now);
      for (const [book, state] of this.#books) {
        sampler.sample(book.ric, time, state.bids, state.asks);
      }
    }
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
      s.tradeEvictions +
      s.barInserts +
      s.barUpdates +
      s.barEvictions +
      s.sampleInserts +
      s.sampleEvictions
    );
  }
}
