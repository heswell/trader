import { defineJoin, defineTable, type RowOf } from "./tableDefinition";

/** Vuu module (namespace) of the exchange simulator: reference + market data. */
export const EXCHANGE_MODULE = "EXCHANGE";
/** Vuu module of the order management system: orders, fills, positions. */
export const OMS_MODULE = "OMS";

export type TradingModule = typeof EXCHANGE_MODULE | typeof OMS_MODULE;

// ---------------------------------------------------------------- EXCHANGE

export const instruments = defineTable({
  module: EXCHANGE_MODULE,
  name: "instruments",
  keyField: "ric",
  description: "Instrument static / reference data.",
  joinFields: ["ric"],
  columns: [
    { name: "ric", dataType: "string" },
    { name: "description", dataType: "string" },
    { name: "isin", dataType: "string", optional: true },
    { name: "currency", dataType: "string" },
    { name: "exchange", dataType: "string", description: "MIC, e.g. XLON" },
    {
      name: "sector",
      dataType: "string",
      optional: true,
      description: "GICS sector, e.g. Financials.",
    },
    { name: "tickSize", dataType: "double" },
    {
      name: "tickBands",
      dataType: "string",
      optional: true,
      description:
        "Optional price-banded ticks 'from:tick;...' (see parseTickBands). Overrides tickSize.",
    },
    { name: "lotSize", dataType: "int" },
    { name: "priceDecimals", dataType: "int" },
    {
      name: "refPrice",
      dataType: "double",
      description: "Reference price used to seed the simulator / price bands.",
    },
    {
      name: "simulated",
      dataType: "boolean",
      description: "True if backed by a live order book in exchange-sim.",
    },
  ],
});

export const prices = defineTable({
  module: EXCHANGE_MODULE,
  name: "prices",
  keyField: "ric",
  description: "Top of book + session statistics, one row per instrument.",
  joinFields: ["ric"],
  columns: [
    { name: "ric", dataType: "string" },
    { name: "bid", dataType: "double" },
    { name: "ask", dataType: "double" },
    { name: "bidSize", dataType: "long" },
    { name: "askSize", dataType: "long" },
    { name: "last", dataType: "double" },
    { name: "lastSize", dataType: "long" },
    { name: "open", dataType: "double" },
    { name: "high", dataType: "double" },
    { name: "low", dataType: "double" },
    { name: "close", dataType: "double", description: "Previous close." },
    { name: "volume", dataType: "long" },
    { name: "turnover", dataType: "double" },
    { name: "vwap", dataType: "double" },
    { name: "change", dataType: "double", description: "last - close" },
    { name: "changePct", dataType: "double", description: "100*change/close" },
    { name: "phase", dataType: "string", description: "TradingPhase" },
    { name: "seq", dataType: "long", description: "Book sequence number." },
    { name: "timestamp", dataType: "epochtimestamp" },
  ],
});

export const depth = defineTable({
  module: EXCHANGE_MODULE,
  name: "depth",
  keyField: "id",
  description:
    "Aggregated order book levels; key 'ric|side|level' (see depthKey). Level 0 is best.",
  columns: [
    { name: "id", dataType: "string" },
    { name: "ric", dataType: "string" },
    { name: "side", dataType: "string", description: "Side" },
    { name: "level", dataType: "int" },
    { name: "price", dataType: "double" },
    { name: "size", dataType: "long" },
    {
      name: "cumSize",
      dataType: "long",
      description: "Cumulative size to this level.",
    },
    { name: "orderCount", dataType: "int" },
    {
      name: "ownSize",
      dataType: "long",
      optional: true,
      description: "Size of the viewing user's working orders at this price.",
    },
    { name: "seq", dataType: "long" },
  ],
  links: [
    { fromColumn: "ric", toTable: "prices", toColumn: "ric" },
    { fromColumn: "ric", toTable: "instrumentPrices", toColumn: "ric" },
  ],
});

export const trades = defineTable({
  module: EXCHANGE_MODULE,
  name: "trades",
  keyField: "tradeId",
  description: "Public time & sales tape (ring buffered).",
  columns: [
    { name: "tradeId", dataType: "string" },
    { name: "ric", dataType: "string" },
    { name: "price", dataType: "double" },
    { name: "size", dataType: "long" },
    { name: "aggressorSide", dataType: "string", description: "Side" },
    { name: "timestamp", dataType: "epochtimestamp" },
    { name: "seq", dataType: "long" },
  ],
  links: [
    { fromColumn: "ric", toTable: "prices", toColumn: "ric" },
    { fromColumn: "ric", toTable: "instrumentPrices", toColumn: "ric" },
  ],
});

/** Levels per side carried by a `bookSamples` row (bidPx0..4, askSz0..4, ...). */
export const BOOK_SAMPLE_LEVELS = 5;

const levelColumns = <const P extends string>(prefix: P, what: string) =>
  [0, 1, 2, 3, 4].map((level) => ({
    name: `${prefix}${level}` as `${P}${0 | 1 | 2 | 3 | 4}`,
    dataType: "double" as const,
    description: `${what} at level ${level} (0 = best; empty when the book is thinner).`,
  }));

export const bars = defineTable({
  module: EXCHANGE_MODULE,
  name: "bars",
  keyField: "id",
  description:
    "OHLCV bars built from exchange trades; key 'ric|interval|start' (see barKey). The current bar updates in place; closed bars are kept in a rolling window per ric / interval. Intervals are exchange-clock (wall) time.",
  columns: [
    { name: "id", dataType: "string" },
    { name: "ric", dataType: "string" },
    {
      name: "interval",
      dataType: "string",
      description: "Bar interval, e.g. 1s, 1m, 5m (exchangeSim.barIntervals).",
    },
    {
      name: "start",
      dataType: "epochtimestamp",
      description: "Bar open time (inclusive), aligned to the interval.",
    },
    {
      name: "end",
      dataType: "epochtimestamp",
      description: "Bar close time (exclusive): start + interval.",
    },
    { name: "open", dataType: "double" },
    { name: "high", dataType: "double" },
    { name: "low", dataType: "double" },
    { name: "close", dataType: "double" },
    { name: "volume", dataType: "long" },
    { name: "turnover", dataType: "double" },
    { name: "vwap", dataType: "double" },
    { name: "trades", dataType: "int", description: "Number of trades." },
    {
      name: "closed",
      dataType: "boolean",
      description: "False for the bar still being built (updated in place).",
    },
    {
      name: "backfilled",
      dataType: "boolean",
      description:
        "True for synthetic history generated at startup (exchangeSim.barBackfill).",
    },
  ],
  links: [
    { fromColumn: "ric", toTable: "prices", toColumn: "ric" },
    { fromColumn: "ric", toTable: "instrumentPrices", toColumn: "ric" },
  ],
});

export const bookSamples = defineTable({
  module: EXCHANGE_MODULE,
  name: "bookSamples",
  keyField: "id",
  description:
    "Periodic order book samples per instrument (rolling window); key 'ric|time' (see bookSampleKey). For depth heatmaps and spread / imbalance charts.",
  columns: [
    { name: "id", dataType: "string" },
    { name: "ric", dataType: "string" },
    {
      name: "time",
      dataType: "epochtimestamp",
      description: "Sample time, aligned to exchangeSim.bookSampleIntervalMs.",
    },
    { name: "bid", dataType: "double" },
    { name: "ask", dataType: "double" },
    { name: "mid", dataType: "double" },
    {
      name: "spreadBps",
      dataType: "double",
      description: "10000 * (ask - bid) / mid.",
    },
    { name: "bidSize", dataType: "long", description: "Size at the best bid." },
    { name: "askSize", dataType: "long", description: "Size at the best ask." },
    {
      name: "bidDepth",
      dataType: "long",
      description: "Cumulative bid size of the top 5 levels.",
    },
    {
      name: "askDepth",
      dataType: "long",
      description: "Cumulative ask size of the top 5 levels.",
    },
    {
      name: "imbalance",
      dataType: "double",
      description:
        "(bidDepth - askDepth) / (bidDepth + askDepth), in [-1, 1]; > 0 = bid heavy.",
    },
    ...levelColumns("bidPx", "Bid price"),
    ...levelColumns("bidSz", "Bid size"),
    ...levelColumns("askPx", "Ask price"),
    ...levelColumns("askSz", "Ask size"),
  ],
  links: [
    { fromColumn: "ric", toTable: "prices", toColumn: "ric" },
    { fromColumn: "ric", toTable: "instrumentPrices", toColumn: "ric" },
  ],
});

// ---------------------------------------------------------------- OMS

export const accounts = defineTable({
  module: OMS_MODULE,
  name: "accounts",
  keyField: "account",
  description: "Trading accounts and their pre-trade risk limits.",
  columns: [
    { name: "account", dataType: "string" },
    { name: "name", dataType: "string" },
    { name: "desk", dataType: "string" },
    { name: "owner", dataType: "string", description: "Owning user / trader." },
    { name: "currency", dataType: "string" },
    { name: "maxOrderQty", dataType: "long" },
    { name: "maxOrderNotional", dataType: "double" },
    { name: "maxPositionNotional", dataType: "double" },
    { name: "enabled", dataType: "boolean" },
  ],
});

const orderColumns = [
  { name: "ric", dataType: "string" },
  { name: "side", dataType: "string", description: "Side" },
  { name: "ordType", dataType: "string", description: "OrdType" },
  { name: "timeInForce", dataType: "string", description: "TimeInForce" },
  { name: "quantity", dataType: "long" },
  {
    name: "price",
    dataType: "double",
    description: "Limit price (0 for MARKET).",
  },
  {
    name: "stopPrice",
    dataType: "double",
    optional: true,
    description: "Reserved.",
  },
  { name: "status", dataType: "string", description: "OrdStatus" },
  { name: "cumQty", dataType: "long" },
  { name: "leavesQty", dataType: "long" },
  { name: "avgPx", dataType: "double" },
  { name: "lastQty", dataType: "long" },
  { name: "lastPx", dataType: "double" },
  { name: "account", dataType: "string" },
  { name: "currency", dataType: "string" },
  {
    name: "rejectReason",
    dataType: "string",
    optional: true,
    description: "RejectReason",
  },
  { name: "text", dataType: "string", optional: true },
  { name: "created", dataType: "epochtimestamp" },
  { name: "lastUpdate", dataType: "epochtimestamp" },
] as const;

export const parentOrders = defineTable({
  module: OMS_MODULE,
  name: "parentOrders",
  keyField: "orderId",
  description: "Client orders as entered via createOrder.",
  joinFields: ["orderId"],
  columns: [
    { name: "orderId", dataType: "string" },
    { name: "clOrdId", dataType: "string", optional: true },
    { name: "trader", dataType: "string" },
    ...orderColumns,
    { name: "version", dataType: "int", description: "Incremented per amend." },
    { name: "notional", dataType: "double", description: "cumQty * avgPx" },
    {
      name: "arrivalPrice",
      dataType: "double",
      description:
        "Mid at order creation (last, else refPrice, when the book is one-sided).",
    },
    {
      name: "slippageBps",
      dataType: "double",
      description:
        "avgPx vs arrivalPrice in bps, signed so positive = worse (paid more / sold lower); 0 until filled.",
    },
    {
      name: "timeToFirstFill",
      dataType: "long",
      description:
        "ms from created to the first fill; 0 until filled (check cumQty).",
    },
    {
      name: "timeToComplete",
      dataType: "long",
      description: "ms from created to FILLED; 0 unless FILLED.",
    },
  ],
  links: [{ fromColumn: "account", toTable: "accounts", toColumn: "account" }],
});

export const childOrders = defineTable({
  module: OMS_MODULE,
  name: "childOrders",
  keyField: "childOrderId",
  description: "Exchange-facing slices of parent orders.",
  columns: [
    { name: "childOrderId", dataType: "string" },
    { name: "parentOrderId", dataType: "string" },
    { name: "exchangeOrderId", dataType: "string", optional: true },
    ...orderColumns,
  ],
  links: [
    {
      fromColumn: "parentOrderId",
      toTable: "parentOrders",
      toColumn: "orderId",
    },
  ],
});

export const fills = defineTable({
  module: OMS_MODULE,
  name: "fills",
  keyField: "execId",
  description: "Executions (ExecType TRADE) against child orders.",
  columns: [
    { name: "execId", dataType: "string" },
    { name: "orderId", dataType: "string", description: "Parent order id." },
    { name: "childOrderId", dataType: "string" },
    {
      name: "tradeId",
      dataType: "string",
      description: "Exchange trade id (trades.tradeId).",
    },
    { name: "account", dataType: "string" },
    { name: "trader", dataType: "string" },
    { name: "ric", dataType: "string" },
    { name: "side", dataType: "string", description: "Side" },
    { name: "quantity", dataType: "long" },
    { name: "price", dataType: "double" },
    { name: "notional", dataType: "double" },
    { name: "currency", dataType: "string" },
    { name: "liquidity", dataType: "string", description: "Liquidity" },
    { name: "timestamp", dataType: "epochtimestamp" },
  ],
  links: [
    { fromColumn: "orderId", toTable: "parentOrders", toColumn: "orderId" },
    {
      fromColumn: "childOrderId",
      toTable: "childOrders",
      toColumn: "childOrderId",
    },
  ],
});

export const positions = defineTable({
  module: OMS_MODULE,
  name: "positions",
  keyField: "id",
  description:
    "Net position per account/instrument; key 'account|ric' (see positionKey). P&L marked to prices.last.",
  joinFields: ["ric"],
  columns: [
    { name: "id", dataType: "string" },
    { name: "account", dataType: "string" },
    { name: "ric", dataType: "string" },
    {
      name: "quantity",
      dataType: "long",
      description: "Net quantity (+long / -short).",
    },
    { name: "boughtQty", dataType: "long" },
    { name: "soldQty", dataType: "long" },
    { name: "avgCost", dataType: "double" },
    { name: "markPx", dataType: "double" },
    { name: "marketValue", dataType: "double" },
    { name: "realizedPnl", dataType: "double" },
    { name: "unrealizedPnl", dataType: "double" },
    { name: "totalPnl", dataType: "double" },
    { name: "currency", dataType: "string" },
    {
      name: "exchange",
      dataType: "string",
      description: "Instrument MIC (from instruments).",
    },
    {
      name: "sector",
      dataType: "string",
      description: "Instrument GICS sector (from instruments).",
    },
    { name: "lastUpdate", dataType: "epochtimestamp" },
  ],
  links: [{ fromColumn: "account", toTable: "accounts", toColumn: "account" }],
});

const pnlColumns = [
  { name: "realizedPnl", dataType: "double" },
  { name: "unrealizedPnl", dataType: "double" },
  { name: "totalPnl", dataType: "double" },
  {
    name: "grossExposure",
    dataType: "double",
    description: "Sum of |market value|.",
  },
  {
    name: "netExposure",
    dataType: "double",
    description: "Sum of signed market value (+long / -short).",
  },
] as const;

export const pnlHistory = defineTable({
  module: OMS_MODULE,
  name: "pnlHistory",
  keyField: "id",
  description:
    "Periodic P&L snapshots per position (rolling window); key 'account|ric|time' (see pnlHistoryKey). A row is written only when the position changed since its previous sample; read as a step series. P&L in instrument currency, *Usd columns converted.",
  columns: [
    { name: "id", dataType: "string" },
    { name: "account", dataType: "string" },
    { name: "ric", dataType: "string" },
    {
      name: "time",
      dataType: "epochtimestamp",
      description: "Sample time, aligned to oms.pnlHistoryIntervalMs.",
    },
    { name: "quantity", dataType: "long" },
    { name: "avgCost", dataType: "double" },
    { name: "markPx", dataType: "double" },
    { name: "marketValue", dataType: "double" },
    ...pnlColumns,
    { name: "totalPnlUsd", dataType: "double" },
    { name: "marketValueUsd", dataType: "double" },
    { name: "currency", dataType: "string" },
  ],
  links: [{ fromColumn: "account", toTable: "accounts", toColumn: "account" }],
});

export const accountPnlHistory = defineTable({
  module: OMS_MODULE,
  name: "accountPnlHistory",
  keyField: "id",
  description:
    "Periodic account totals, in USD (rolling window); key 'account|time' (see accountPnlHistoryKey).",
  columns: [
    { name: "id", dataType: "string" },
    { name: "account", dataType: "string" },
    {
      name: "time",
      dataType: "epochtimestamp",
      description: "Sample time, aligned to oms.pnlHistoryIntervalMs.",
    },
    {
      name: "positions",
      dataType: "int",
      description: "Positions with a non-zero quantity.",
    },
    ...pnlColumns,
  ],
  links: [{ fromColumn: "account", toTable: "accounts", toColumn: "account" }],
});

// ---------------------------------------------------------------- joins

/** Instrument grid: static + live prices. */
export const instrumentPrices = defineJoin({
  module: EXCHANGE_MODULE,
  name: "instrumentPrices",
  baseTable: instruments,
  joinTable: prices,
  left: "ric",
  right: "ric",
  type: "LeftOuterJoin",
  description: "instruments x prices on ric (instrument grid).",
});

/**
 * Positions with live prices. Cross-module: requires EXCHANGE and OMS modules
 * in the same VuuServer, with EXCHANGE registered first. When the OMS runs
 * standalone it maintains positions.markPx itself.
 */
export const positionPrices = defineJoin({
  module: OMS_MODULE,
  name: "positionPrices",
  baseTable: positions,
  joinTable: prices,
  left: "ric",
  right: "ric",
  type: "LeftOuterJoin",
  joinColumns: ["bid", "ask", "last", "change", "changePct", "phase"],
  description: "positions x prices on ric (live P&L view).",
});

export const exchangeTables = {
  instruments,
  prices,
  depth,
  trades,
  bars,
  bookSamples,
} as const;
export const omsTables = {
  accounts,
  parentOrders,
  childOrders,
  fills,
  positions,
  pnlHistory,
  accountPnlHistory,
} as const;
export const tradingTables = { ...exchangeTables, ...omsTables } as const;
export const tradingJoins = { instrumentPrices, positionPrices } as const;

export type TradingTableName = keyof typeof tradingTables;
export type TradingJoinName = keyof typeof tradingJoins;

export type InstrumentRow = RowOf<typeof instruments>;
export type PriceRow = RowOf<typeof prices>;
export type DepthRow = RowOf<typeof depth>;
export type TradeRow = RowOf<typeof trades>;
export type AccountRow = RowOf<typeof accounts>;
export type ParentOrderRow = RowOf<typeof parentOrders>;
export type ChildOrderRow = RowOf<typeof childOrders>;
export type FillRow = RowOf<typeof fills>;
export type PositionRow = RowOf<typeof positions>;
export type BarRow = RowOf<typeof bars>;
export type BookSampleRow = RowOf<typeof bookSamples>;
export type PnlHistoryRow = RowOf<typeof pnlHistory>;
export type AccountPnlHistoryRow = RowOf<typeof accountPnlHistory>;
