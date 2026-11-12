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
    {
      name: "instrumentType",
      dataType: "string",
      description: "InstrumentType: EQUITY | FUTURE.",
    },
    {
      name: "underlying",
      dataType: "string",
      optional: true,
      description: "Futures: ric of the underlying instrument.",
    },
    {
      name: "expiry",
      dataType: "epochtimestamp",
      optional: true,
      description: "Futures: last trading time.",
    },
    {
      name: "contractMultiplier",
      dataType: "double",
      description:
        "Value of one unit of quantity per unit of price (1 for equities). Notional = quantity x price x contractMultiplier.",
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

export const bookOrders = defineTable({
  module: EXCHANGE_MODULE,
  name: "bookOrders",
  keyField: "orderId",
  description:
    "Order-by-order (L3) book: one row per resting order, anonymous. Sort by side, price, then priority, for queue order.",
  columns: [
    {
      name: "orderId",
      dataType: "string",
      description:
        "Exchange order id (matches childOrders.exchangeOrderId for OMS orders).",
    },
    { name: "ric", dataType: "string" },
    { name: "side", dataType: "string", description: "Side" },
    { name: "price", dataType: "double" },
    { name: "size", dataType: "long", description: "Open (resting) size." },
    {
      name: "entryTime",
      dataType: "epochtimestamp",
      description:
        "Time the order took its place in the queue (reset when an amend loses priority).",
    },
    {
      name: "seq",
      dataType: "long",
      description: "bookEvents seq of the order's last change.",
    },
    {
      name: "priority",
      dataType: "long",
      description:
        "Queue order at its price: lower is nearer the front. Assigned when the order joins the back of the queue (new, or an amend that lost priority).",
    },
  ],
  links: [
    { fromColumn: "ric", toTable: "prices", toColumn: "ric" },
    { fromColumn: "ric", toTable: "instrumentPrices", toColumn: "ric" },
  ],
});

export const bookEvents = defineTable({
  module: EXCHANGE_MODULE,
  name: "bookEvents",
  keyField: "id",
  description:
    "Order-by-order (L3) event tape, ring buffered; key 'ric|seq' (see bookEventKey). Empty unless exchangeSim.bookEvents is on.",
  columns: [
    { name: "id", dataType: "string" },
    { name: "ric", dataType: "string" },
    {
      name: "seq",
      dataType: "long",
      description: "Per-instrument event sequence: gap-free, starts at 1.",
    },
    { name: "type", dataType: "string", description: "BookEventType" },
    { name: "orderId", dataType: "string" },
    {
      name: "side",
      dataType: "string",
      description: "Side of the resting order.",
    },
    { name: "price", dataType: "double" },
    {
      name: "size",
      dataType: "long",
      description:
        "ADD: shown size. EXECUTE: traded size. REDUCE / DELETE: size removed.",
    },
    {
      name: "leaves",
      dataType: "long",
      description: "Open size left after the event (0 = gone from the book).",
    },
    {
      name: "tradeId",
      dataType: "string",
      optional: true,
      description: "EXECUTE only: the trades table row.",
    },
    { name: "timestamp", dataType: "epochtimestamp" },
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

// ---------------------------------------------------------------- EXCHANGE: simulator admin
// Visible only with the sim-admin role (see docs/simulator-bots.md).

const ricLinks = [
  { fromColumn: "ric", toTable: "prices", toColumn: "ric" },
  { fromColumn: "ric", toTable: "instrumentPrices", toColumn: "ric" },
] as const;

export const simBooks = defineTable({
  module: EXCHANGE_MODULE,
  name: "simBooks",
  keyField: "ric",
  description:
    "Simulator state per simulated instrument: hidden fair value, model settings, bot rates and maker inventory (sim-admin only).",
  columns: [
    { name: "ric", dataType: "string" },
    { name: "phase", dataType: "string", description: "TradingPhase" },
    { name: "haltReason", dataType: "string" },
    {
      name: "fair",
      dataType: "double",
      description: "Hidden fair value of the price model.",
    },
    {
      name: "walk",
      dataType: "double",
      description: "Fair value without transient impact (the random walk).",
    },
    {
      name: "impactOffsetBps",
      dataType: "double",
      description:
        "Transient impact: fair over walk, bps. Fades with impactHalfLifeSec.",
    },
    {
      name: "impactTodayBps",
      dataType: "double",
      description:
        "Permanent move from aggressive flow since the session close, bps.",
    },
    {
      name: "impactK",
      dataType: "double",
      description:
        "Impact per $100k of aggressive notional at 30% volatility, bps (0 = off).",
    },
    {
      name: "driftBpsPerHour",
      dataType: "double",
      description: "Trend of the walk, bps per hour of model time (0 = none).",
    },
    { name: "bandLow", dataType: "double", description: "Lower price band." },
    { name: "bandHigh", dataType: "double", description: "Upper price band." },
    { name: "mid", dataType: "double", optional: true },
    {
      name: "gapBps",
      dataType: "double",
      optional: true,
      description: "10000 * (mid - fair) / fair.",
    },
    { name: "spreadBps", dataType: "double", optional: true },
    {
      name: "volatility",
      dataType: "double",
      description: "Annualised volatility of the price model.",
    },
    {
      name: "realisedVolatility",
      dataType: "double",
      description:
        "Annualised volatility of mid over the last ~30s (comparable with volatility).",
    },
    {
      name: "mmRate",
      dataType: "double",
      description: "Market maker churn, events/s for the instrument.",
    },
    {
      name: "takerRate",
      dataType: "double",
      description: "Taker orders/s for the instrument, before activity.",
    },
    {
      name: "activity",
      dataType: "double",
      description: "Intraday activity multiplier applied to takerRate.",
    },
    {
      name: "imbalance",
      dataType: "double",
      description: "Signed aggressor volume share over ~10s, -1 .. +1.",
    },
    {
      name: "mmInventory",
      dataType: "long",
      description: "Net position of the instrument's market makers.",
    },
    { name: "bots", dataType: "int", description: "Bots on the instrument." },
    { name: "tradeCount", dataType: "long" },
    { name: "volume", dataType: "long" },
    { name: "updated", dataType: "epochtimestamp" },
  ],
  links: ricLinks,
});

export const bots = defineTable({
  module: EXCHANGE_MODULE,
  name: "bots",
  keyField: "botId",
  description:
    "One row per simulator bot: ledger, P&L, resting orders and rates (sim-admin only).",
  columns: [
    { name: "botId", dataType: "string", description: "<ric>/<localId>" },
    { name: "ric", dataType: "string" },
    { name: "kind", dataType: "string", description: "BotKind" },
    { name: "localId", dataType: "string" },
    { name: "account", dataType: "string" },
    { name: "position", dataType: "long" },
    { name: "avgPrice", dataType: "double", optional: true },
    { name: "positionUsd", dataType: "double" },
    { name: "realisedPnlUsd", dataType: "double" },
    { name: "unrealisedPnlUsd", dataType: "double" },
    { name: "totalPnlUsd", dataType: "double" },
    { name: "orders", dataType: "long" },
    { name: "modifies", dataType: "long" },
    { name: "cancels", dataType: "long" },
    { name: "fills", dataType: "long" },
    { name: "makerFills", dataType: "long" },
    { name: "volume", dataType: "long", description: "Bought + sold." },
    { name: "notionalUsd", dataType: "double" },
    { name: "restingOrders", dataType: "int" },
    { name: "restingBidQty", dataType: "long" },
    { name: "restingAskQty", dataType: "long" },
    {
      name: "rate",
      dataType: "double",
      description:
        "The bot's current rate: its share of the instrument's rate for its group (takers include activity).",
    },
    {
      name: "effectiveRate",
      dataType: "double",
      description: "Orders sent per second, smoothed.",
    },
    {
      name: "skewTicks",
      dataType: "int",
      optional: true,
      description: "Market makers: inventory skew of the quote centre.",
    },
    {
      name: "quotes",
      dataType: "int",
      optional: true,
      description: "Market makers: resting quotes.",
    },
    {
      name: "paused",
      dataType: "boolean",
      description: "Not stepped (pauseBots); its quotes are pulled.",
    },
    { name: "updated", dataType: "epochtimestamp" },
  ],
  links: ricLinks,
});

export const botParams = defineTable({
  module: EXCHANGE_MODULE,
  name: "botParams",
  keyField: "id",
  description:
    "One row per bot parameter, with its spec (sim-admin only); key 'botId|name' (see botParamKey).",
  columns: [
    { name: "id", dataType: "string" },
    { name: "botId", dataType: "string" },
    { name: "ric", dataType: "string" },
    { name: "kind", dataType: "string" },
    { name: "name", dataType: "string" },
    {
      name: "type",
      dataType: "string",
      description: "number | integer | string | boolean",
    },
    {
      name: "value",
      dataType: "string",
      description: "Current value as text (numbers in plain decimal).",
    },
    { name: "min", dataType: "double", optional: true },
    { name: "max", dataType: "double", optional: true },
    { name: "unit", dataType: "string" },
    { name: "description", dataType: "string" },
    { name: "readOnly", dataType: "boolean" },
    {
      name: "baseline",
      dataType: "string",
      description: "Value when the bot was created.",
    },
    {
      name: "changed",
      dataType: "boolean",
      description: "value differs from baseline (setBotParams or a scenario).",
    },
  ],
  links: [
    { fromColumn: "botId", toTable: "bots", toColumn: "botId" },
    ...ricLinks,
  ],
});

const ownerVolume = (side: "Buy" | "Sell", verb: string) =>
  (["mm", "taker", "oms", "bot"] as const).map((group) => ({
    name: `${group}${side}`,
    dataType: "long" as const,
    description: `Quantity ${verb} aggressively by ${OWNER_GROUP_LABEL[group]} in the interval.`,
  }));

const OWNER_GROUP_LABEL = {
  mm: "market makers",
  taker: "noise takers",
  oms: "OMS (gateway) orders",
  bot: "other bots",
} as const;

export const simSamples = defineTable({
  module: EXCHANGE_MODULE,
  name: "simSamples",
  keyField: "id",
  description:
    "Simulator history per instrument (rolling window, sim-admin only); key 'ric|time' (see simSampleKey). Fair value, walk and quotes with aggressive volume by owner group.",
  columns: [
    { name: "id", dataType: "string" },
    { name: "ric", dataType: "string" },
    {
      name: "time",
      dataType: "epochtimestamp",
      description: "Sample time, aligned to exchangeSim.simSampleIntervalMs.",
    },
    { name: "fair", dataType: "double" },
    { name: "walk", dataType: "double" },
    { name: "mid", dataType: "double", optional: true },
    { name: "bid", dataType: "double", optional: true },
    { name: "ask", dataType: "double", optional: true },
    { name: "impactOffsetBps", dataType: "double" },
    ...ownerVolume("Buy", "bought"),
    ...ownerVolume("Sell", "sold"),
    ...(["mm", "taker", "oms", "bot"] as const).map((group) => ({
      name: `${group}Net`,
      dataType: "long" as const,
      description: `${group}Buy - ${group}Sell: signed aggressive volume of ${OWNER_GROUP_LABEL[group]}.`,
    })),
    {
      name: "netFlow",
      dataType: "long",
      description: "All aggressive buys minus sells in the interval.",
    },
    { name: "mmInventory", dataType: "long" },
  ],
  links: ricLinks,
});

export const botHistory = defineTable({
  module: EXCHANGE_MODULE,
  name: "botHistory",
  keyField: "id",
  description:
    "Bot stats sampled every exchangeSim.botHistoryIntervalMs (rolling window, sim-admin only); key 'botId|time' (see botHistoryKey).",
  columns: [
    { name: "id", dataType: "string" },
    { name: "botId", dataType: "string" },
    { name: "ric", dataType: "string" },
    { name: "kind", dataType: "string" },
    { name: "time", dataType: "epochtimestamp" },
    { name: "position", dataType: "long" },
    { name: "totalPnlUsd", dataType: "double" },
    { name: "realisedPnlUsd", dataType: "double" },
    { name: "volume", dataType: "long" },
    { name: "orders", dataType: "long" },
  ],
  links: [
    { fromColumn: "botId", toTable: "bots", toColumn: "botId" },
    ...ricLinks,
  ],
});

export const botFills = defineTable({
  module: EXCHANGE_MODULE,
  name: "botFills",
  keyField: "id",
  description:
    "Attributed fills: one row per side of every trade (ring buffer, sim-admin only); key 'tradeId|M' or 'tradeId|T' (see botFillKey).",
  columns: [
    { name: "id", dataType: "string" },
    { name: "tradeId", dataType: "string" },
    { name: "ric", dataType: "string" },
    {
      name: "party",
      dataType: "string",
      description: "Bot id, or 'OMS:<account>' for gateway orders.",
    },
    {
      name: "group",
      dataType: "string",
      description: "mm | taker | oms | bot",
    },
    { name: "kind", dataType: "string", description: "Bot kind ('' for OMS)." },
    { name: "account", dataType: "string" },
    { name: "side", dataType: "string", description: "BUY | SELL" },
    { name: "price", dataType: "double" },
    { name: "quantity", dataType: "long" },
    { name: "notionalUsd", dataType: "double" },
    {
      name: "liquidity",
      dataType: "string",
      description: "ADDED (maker) | REMOVED (taker).",
    },
    { name: "timestamp", dataType: "epochtimestamp" },
    {
      name: "markoutBps",
      dataType: "double",
      optional: true,
      description:
        "Mid exchangeSim.markoutMs after the fill against the fill price, bps, signed so > 0 is a gain for this side. Empty until then.",
    },
  ],
  links: ricLinks,
});

export const simEvents = defineTable({
  module: EXCHANGE_MODULE,
  name: "simEvents",
  keyField: "id",
  description:
    "Audit log of simulator control actions (ring buffer, sim-admin only): admin RPCs and scenario steps.",
  columns: [
    { name: "id", dataType: "string", description: "The seq, as text." },
    { name: "seq", dataType: "long" },
    { name: "time", dataType: "epochtimestamp" },
    {
      name: "user",
      dataType: "string",
      description: "Who made the change ('scenario' for a run's steps).",
    },
    { name: "action", dataType: "string" },
    {
      name: "target",
      dataType: "string",
      description: "Instruments or bots changed; '' = every instrument.",
    },
    {
      name: "details",
      dataType: "string",
      description: "Parameters, as JSON.",
    },
    { name: "runId", dataType: "string", description: "Scenario run, or ''." },
  ],
});

export const scenarios = defineTable({
  module: EXCHANGE_MODULE,
  name: "scenarios",
  keyField: "name",
  description: "Scenarios the simulator can run (sim-admin only).",
  columns: [
    { name: "name", dataType: "string" },
    { name: "description", dataType: "string" },
    { name: "steps", dataType: "int" },
    {
      name: "targets",
      dataType: "string",
      description:
        "Default instruments: rics, 'sector X', 'random N' or 'all'.",
    },
    { name: "args", dataType: "string", description: "Default args, as JSON." },
  ],
});

export const scenarioRuns = defineTable({
  module: EXCHANGE_MODULE,
  name: "scenarioRuns",
  keyField: "runId",
  description: "Scenario runs since the server started (sim-admin only).",
  columns: [
    { name: "runId", dataType: "string" },
    { name: "name", dataType: "string" },
    {
      name: "status",
      dataType: "string",
      description: "RUNNING | DONE | STOPPED | ABORTED | FAILED",
    },
    { name: "user", dataType: "string" },
    { name: "targets", dataType: "string" },
    { name: "args", dataType: "string", description: "As JSON." },
    { name: "startedAt", dataType: "epochtimestamp" },
    { name: "step", dataType: "int", description: "Steps done." },
    { name: "steps", dataType: "int" },
    { name: "nextAt", dataType: "epochtimestamp", optional: true },
    {
      name: "reverted",
      dataType: "boolean",
      description: "Targets were put back to their settings before the run.",
    },
    { name: "error", dataType: "string" },
  ],
});

export const simSession = defineTable({
  module: EXCHANGE_MODULE,
  name: "simSession",
  keyField: "id",
  description:
    "The simulated market session: one row, key 'session' (sim-admin only).",
  columns: [
    { name: "id", dataType: "string" },
    { name: "phase", dataType: "string" },
    { name: "nextPhase", dataType: "string", optional: true },
    { name: "nextChangeAt", dataType: "epochtimestamp", optional: true },
    {
      name: "forced",
      dataType: "boolean",
      description: "setMarketPhase override in force.",
    },
    {
      name: "forcedUntil",
      dataType: "epochtimestamp",
      optional: true,
      description: "When the override ends; empty = until changed.",
    },
    {
      name: "scheduled",
      dataType: "boolean",
      description: "A session schedule is configured (else always open).",
    },
    {
      name: "timeOfDay",
      dataType: "string",
      description: "Session clock, HH:MM in the session time zone.",
    },
    { name: "timeScale", dataType: "double" },
    { name: "pausedBots", dataType: "int" },
    { name: "runningScenarios", dataType: "int" },
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
    description: "STOP / STOP_LIMIT trigger price (0 otherwise).",
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
    {
      name: "strategy",
      dataType: "string",
      description: "AlgoStrategy: DMA, TWAP, VWAP or POV.",
    },
    {
      name: "algoStart",
      dataType: "epochtimestamp",
      description: "Clock time the algo starts working; 0 for DMA.",
    },
    {
      name: "algoEnd",
      dataType: "epochtimestamp",
      description:
        "Clock time the algo must finish by; 0 = none (DMA, open-ended POV).",
    },
    {
      name: "participationPct",
      dataType: "double",
      description: "POV target share of market volume (%); 0 otherwise.",
    },
    {
      name: "targetQty",
      dataType: "long",
      description:
        "Quantity the algo schedule says should be filled by now (compare cumQty); equals quantity for DMA.",
    },
    {
      name: "triggeredAt",
      dataType: "epochtimestamp",
      description:
        "STOP / STOP_LIMIT: clock time the stop triggered and the order went to the exchange; 0 while waiting (and for other types).",
    },
  ],
  links: [{ fromColumn: "account", toTable: "accounts", toColumn: "account" }],
});

/**
 * parentOrders columns that tick with algo progress (on the algo timer) rather
 * than on order events: an edit-session amend is not stale because of them.
 */
export const PARENT_ORDER_PROGRESS_COLUMNS: readonly string[] = Object.freeze([
  "targetQty",
]);

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
    {
      name: "instrumentType",
      dataType: "string",
      description: "InstrumentType (from instruments).",
    },
    {
      name: "underlying",
      dataType: "string",
      description: "Futures: underlying ric (from instruments); '' otherwise.",
    },
    {
      name: "marketValueUsd",
      dataType: "double",
      description:
        "marketValue in USD (instrument usdPerPriceUnit; marketValue already includes the contract multiplier).",
    },
    {
      name: "totalPnlUsd",
      dataType: "double",
      description: "totalPnl in USD (instrument usdPerPriceUnit).",
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
export const clientBots = defineTable({
  module: OMS_MODULE,
  name: "clientBots",
  keyField: "botId",
  description:
    "Simulated clients sending TWAP / VWAP / POV parent orders through the OMS (sim-admin only).",
  columns: [
    { name: "botId", dataType: "string", description: "CB<n>" },
    { name: "persona", dataType: "string", description: "ClientPersona" },
    { name: "account", dataType: "string" },
    {
      name: "paused",
      dataType: "boolean",
      description: "Sends no new orders; live parents keep working.",
    },
    { name: "sideMode", dataType: "string", description: "ClientSideMode" },
    {
      name: "ordersPerMin",
      dataType: "double",
      description: "Parent orders per minute (wall clock) at average activity.",
    },
    { name: "live", dataType: "int", description: "Working parent orders." },
    { name: "submitted", dataType: "long" },
    { name: "rejected", dataType: "long" },
    {
      name: "completed",
      dataType: "long",
      description: "Parents that finished (filled, cancelled or expired).",
    },
    { name: "filledQty", dataType: "long" },
    { name: "filledUsd", dataType: "double" },
    {
      name: "slippageBps",
      dataType: "double",
      description:
        "Average slippage against arrival, weighted by filled notional (> 0 = worse).",
    },
    { name: "lastOrderId", dataType: "string" },
    {
      name: "lastReject",
      dataType: "string",
      description: "Reason and text of the most recent reject.",
    },
    { name: "updated", dataType: "epochtimestamp" },
  ],
});

export const clientBotParams = defineTable({
  module: OMS_MODULE,
  name: "clientBotParams",
  keyField: "id",
  description:
    "One row per client bot parameter, with its spec (sim-admin only); key 'botId|name'.",
  columns: [
    { name: "id", dataType: "string" },
    { name: "botId", dataType: "string" },
    { name: "persona", dataType: "string" },
    { name: "account", dataType: "string" },
    { name: "name", dataType: "string" },
    {
      name: "type",
      dataType: "string",
      description: "number | integer | string | boolean",
    },
    { name: "value", dataType: "string" },
    { name: "min", dataType: "double", optional: true },
    { name: "max", dataType: "double", optional: true },
    { name: "unit", dataType: "string" },
    { name: "description", dataType: "string" },
    { name: "readOnly", dataType: "boolean" },
    {
      name: "baseline",
      dataType: "string",
      description: "Value when the bot was added.",
    },
    { name: "changed", dataType: "boolean" },
  ],
  links: [{ fromColumn: "botId", toTable: "clientBots", toColumn: "botId" }],
});

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
  bookOrders,
  bookEvents,
  simBooks,
  bots,
  botParams,
  simSamples,
  botHistory,
  botFills,
  simEvents,
  scenarios,
  scenarioRuns,
  simSession,
} as const;
export const omsTables = {
  accounts,
  parentOrders,
  childOrders,
  fills,
  positions,
  pnlHistory,
  accountPnlHistory,
  clientBots,
  clientBotParams,
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
export type BookOrderRow = RowOf<typeof bookOrders>;
export type BookEventRow = RowOf<typeof bookEvents>;
export type SimBookRow = RowOf<typeof simBooks>;
export type BotRow = RowOf<typeof bots>;
export type BotParamRow = RowOf<typeof botParams>;
export type SimSampleRow = RowOf<typeof simSamples>;
export type BotHistoryRow = RowOf<typeof botHistory>;
export type BotFillRow = RowOf<typeof botFills>;
export type SimEventRow = RowOf<typeof simEvents>;
export type ScenarioRow = RowOf<typeof scenarios>;
export type ScenarioRunRow = RowOf<typeof scenarioRuns>;
export type SimSessionRow = RowOf<typeof simSession>;
export type PnlHistoryRow = RowOf<typeof pnlHistory>;
export type AccountPnlHistoryRow = RowOf<typeof accountPnlHistory>;
