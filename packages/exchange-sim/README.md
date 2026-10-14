# @heswell/exchange-sim

A simulated exchange running inside a Vuu server. It keeps one limit order book per active instrument
(`@heswell/hft-limit-order-book`). Market-maker and noise-taker bots trade against those books, and a
GBM reference price drives them. The results are published to the `EXCHANGE` module tables defined in
`@heswell/trading-schemas`. An in-process gateway lets the OMS (Phase 2) trade on the same books.

```
src/
  reference/      instrument universe (336 listings, 9 venues, tick bands, lot sizes, ref prices)
  engine/         ExchangeSimulator, InstrumentBook, PriceModel, TradingSession, bots/{MarketMaker,NoiseTaker}
  publish/        MarketDataPublisher (prices / depth deltas / trades ring buffer), TradeRingBuffer
  gateway/        SimExchangeGateway: in-process order entry + execution reports
  modules/exchange ExchangeModule (Vuu module) and ExchangeAdminService (admin RPCs)
  config.ts       knobs (application.conf `exchangeSim.*` / `EXCHANGE_SIM_*` env)
scripts/          start.ts (stand-alone server), bench.ts
```

## Running

- `bun run start:all` (repo root, also `bun run dev`): the `EXCHANGE` module is hosted inside the portal server,
  and the portal's Trading features (Watchlist, Depth, Ladder, Tape, ...) show it. See
  [docs/portal-integration.md](../../docs/portal-integration.md).
- `bun run --cwd packages/exchange-sim start`: stand-alone server on `ws://localhost:8094/websocket-exchange-sim`.
  It uses permissive auth over plain HTTP (`vuu.ssl=false`, no certificate): POST `{username,password}`
  to `http://localhost:8446/api/authn` to get a token.
- `bun run --cwd packages/exchange-sim bench [--mode=max|realtime|both] [--seconds=10] [--subscribe]`.

Embedding in another server:

```ts
import { ExchangeModule, createExchangeSimulator, loadExchangeSimConfig } from "@heswell/exchange-sim";

const sim = createExchangeSimulator({ config: loadExchangeSimConfig(config /* service-utils Config */) });
serverConfig.withModule(ExchangeModule(sim));   // starts ticking once its tables are loaded
// sim.gateway -> pass to the OMS module
```

## Tables (module `EXCHANGE`)

| Table | Key | Contents |
| --- | --- | --- |
| `instruments` | `ric` | Every listing, static. `simulated` marks instruments that have a live book. |
| `prices` | `ric` | One row per listing. The row shows bid/ask/sizes, last/lastSize, OHLC, volume, turnover, vwap, change/changePct (vs `close` = refPrice), phase, seq and timestamp. Instruments without a book stay `CLOSED`. |
| `depth` | `ric\|side\|level` | Top `depthLevels` (10) levels per side: price, size, cumSize, orderCount, seq. Updates are deltas; a level is touched only when its values change, and vanished levels are deleted. |
| `trades` | `tradeId` | Time and sales across all instruments. It is a ring buffer of `tradesCapacity` (50k) rows; the oldest rows are deleted. `aggressorSide` is the taker side. |
| `instrumentPrices` | `ric` | A join of instruments and prices. |

Publishing is coalesced. Every `publishIntervalMs`, each book that changed is written once: one prices
row plus a depth delta. Trades since the last flush are then appended. A prices row is skipped when
nothing visible changed.

## Market model

- **Universe.** 336 realistic listings: Nasdaq, NYSE, LSE, HKEX, Xetra, Euronext Paris/Amsterdam,
  Borsa Italiana and SIX. Each has a currency, a tick schedule (price-banded, e.g. MiFID-style bands for EU venues),
  a lot size and a reference price. The data was derived from the index constituents in vuu-websocket's
  basket-trading reference data plus some European large caps, then generated into `src/reference/universe.ts`; nothing is imported at
  runtime. `activeInstruments` (default 200) are simulated, interleaved by venue, or the explicit
  `instruments` list is used.
- **Price model.** A GBM fair value with a per-instrument annualised vol (20–50%, or
  `defaultVolatility`). Time is scaled by `timeScale` to make intraday-looking moves visible. The value
  is reflected inside the static band refPrice ±`priceBandPct`, and published prices are on the tick grid.
- **Phases.** `CONTINUOUS`, `HALTED` (admin), and `CLOSED` for instruments without a book. A halted
  book rejects new orders and amends but accepts cancels; bots pause.
- **Trading session.** A market-wide schedule (`TradingSession`) drives every book through
  `CLOSED` → `PRE_OPEN` → `CONTINUOUS` → `CLOSED` each day. It is evaluated at the start of every
  `step(now)` (so a `ManualClock` drives it in tests and in-browser test data), and the phase is
  published per instrument on `prices.phase`. By default no session is configured and the market is
  always `CONTINUOUS`. With a schedule:
  - `PRE_OPEN` (`preOpenMinutes` before `sessionOpen`): bots are idle; LIMIT DAY/GTC orders,
    amends and cancels are accepted. IOC/FOK are rejected (`UNSUPPORTED_TIF`) and MARKET orders are
    rejected (`UNSUPPORTED_ORD_TYPE`) because there is no auction. There is no auction uncross
    either: crossing limit orders entered in `PRE_OPEN` match immediately (a simplification).
  - `CONTINUOUS` (`sessionOpen` to `sessionClose`): normal trading.
  - `CLOSED`: at the transition the bots pull all their quotes and every live DAY order is
    `EXPIRED` ("DAY order expired at market close"); GTC orders keep resting. New orders and
    amends are rejected with `MARKET_CLOSED`; cancels are still accepted.
  - A `HALTED` book stays halted across session changes (its DAY orders still expire at the
    close); `resumeInstrument` returns it to the current market phase.
  - `sim.marketPhase` and `sim.sessionStatus()` (`{phase, nextPhase, nextChangeAt, forced}`) expose
    the state; the `setMarketPhase` admin RPC overrides it.
- **Market makers.** There are `mmPerInstrument` MMs (accounts `MM1..`, owner `bot:mm`) per instrument.
  Each quotes `mmLevels` per side on a tick grid around fair value, with a half spread of about 2–6 bps,
  level spacing of 1–3 bps, and inventory skew. They requote when fair value moves, by cancel/replace of
  only the levels that changed. `mmRate` adds random discretionary cancel/replace churn per second.
- **Takers.** Accounts `TAKER1..3` (owner `bot:taker`) send Poisson arrivals at `takerRate`/s per
  instrument: mostly market orders and aggressive IOC limits, plus passive limits and occasional
  multi-level sweeps.
- **Scheduling.** One `setInterval(botStepMs)` steps every book in a rotating order, so the work is
  batched rather than spread across one timer per bot. `maxOpsPerStep` caps one step; the rest are
  deferred. Elapsed time is clamped to `maxStepMs`, so a stall doesn't cause a burst.
  Everything runs on an injected `Clock` and a seeded RNG, so tests are deterministic.

## Configuration

Set `exchangeSim.<key>` in application.conf, or `EXCHANGE_SIM_<UPPER_SNAKE_KEY>` in the environment
(env wins). Example: `EXCHANGE_SIM_ACTIVE_INSTRUMENTS=50`.

| Key | Default | Meaning |
| --- | --- | --- |
| `activeInstruments` | 200 | Instruments with a live book. |
| `instruments` | `""` | Comma-separated rics to simulate; overrides `activeInstruments`. |
| `seed` | 42 | RNG seed. |
| `botStepMs` | 20 | Bot / price-model step interval (ms). |
| `maxStepMs` | 250 | Clamp on elapsed time per step (ms). |
| `maxOpsPerStep` | 5000 | Book operations budget per step. |
| `publishIntervalMs` | 100 | Table flush interval (ms). |
| `depthLevels` | 10 | Depth levels per side. |
| `tradesCapacity` | 50000 | Trades ring buffer size. |
| `priceBandPct` | 0.2 | Static band around refPrice (±20%). |
| `timeScale` | 10 | Price-model time multiplier. |
| `defaultVolatility` | 0 | Annualised vol for all instruments (0 = per-instrument 20–50%). |
| `mmPerInstrument` | 2 | Market makers per book. |
| `mmLevels` | 5 | Quote levels per side per MM. |
| `mmRate` | 10 | MM discretionary churn events/s per instrument (0 = MMs paused). |
| `takerRate` | 8 | Taker orders/s per instrument (0 = off). |
| `baseNotionalUsd` | 20000 | Typical order / quote notional. |
| `sessionOpen` | `""` | Session open, `HH:MM` UTC (`EXCHANGE_SIM_SESSION_OPEN`). Set with `sessionClose`; both empty = always open. |
| `sessionClose` | `""` | Session close, `HH:MM` UTC (`EXCHANGE_SIM_SESSION_CLOSE`). Earlier than `sessionOpen` = overnight session. |
| `preOpenMinutes` | 0 | Minutes of `PRE_OPEN` before the open (`EXCHANGE_SIM_PRE_OPEN_MINUTES`). |
| `sessionDayMs` | 0 | Fast simulated day (`EXCHANGE_SIM_SESSION_DAY_MS`): the 24h schedule is compressed into this many ms of clock time (aligned to multiples of it since the epoch); open/close default to 08:00/16:30 when unset. 0 = real 24h day. |

Book events/s scale roughly linearly with `activeInstruments`, `takerRate` and `mmRate`.

Session examples: `EXCHANGE_SIM_SESSION_OPEN=08:00 EXCHANGE_SIM_SESSION_CLOSE=16:30
EXCHANGE_SIM_PRE_OPEN_MINUTES=30` for a real-time day, or `EXCHANGE_SIM_SESSION_DAY_MS=120000` for a
2-minute simulated day (08:00–16:30 scaled, i.e. ~42s open). The dev / e2e stacks configure no
session, so they are always open.

## Admin RPCs

Admin RPCs are registered on every `EXCHANGE` table (including `instrumentPrices`) through
`DefaultRpcHandler`. Call them with an `RPC_REQUEST` in a `VIEWPORT_CONTEXT`. Params are validated
with `validateRpcParams`. Results follow the trading-schemas contract: `rpcSuccess({rics})`, or
`rpcError("<RejectReason>: text")`.

| RPC | Params | Notes |
| --- | --- | --- |
| `setVolatility` | `{ric?, volatility}` | Omit `ric` to apply to all books. |
| `haltInstrument` | `{ric, reason?}` | Sets phase to `HALTED`. |
| `resumeInstrument` | `{ric, auction?}` | Returns to the current market phase (`CONTINUOUS` unless the session is closed / pre-open); `auction: true` returns `INVALID_REQUEST` (auctions not implemented). |
| `setBotRate` | `{ric?, bot: MARKET_MAKER\|TAKER\|ALL, rate}` | Rate per instrument; 0 pauses. |
| `setMarketPhase` | `{phase: PRE_OPEN\|CONTINUOUS\|CLOSED}` | Forces the market-wide phase now (same transition logic, so `CLOSED` expires DAY orders) until the next scheduled change, or indefinitely when no session is configured. Halted books stay halted. Returns every simulated ric. |

Unknown or unsimulated rics give `UNKNOWN_INSTRUMENT`.

## Gateway API (for the OMS)

`sim.gateway` implements `ExchangeGateway` (`src/gateway/types.ts`). It runs in-process and is
synchronous. The OMS runs in the same VuuServer and receives the gateway from whoever created the
simulator.

```ts
const off = sim.gateway.onExecutionReport((er) => { /* update child order + fills */ });

const exchangeOrderId = sim.gateway.submit({
  account: "ACC1", clOrdId: "C1", ric: "AAPL.OQ",
  side: Side.Buy, ordType: OrdType.Limit, quantity: 100, price: 190.25,
  timeInForce: TimeInForce.Day,          // DAY (default) | GTC | IOC | FOK
});
sim.gateway.amend(exchangeOrderId, { quantity: 200, price: 190.2, clOrdId: "C1-1" });
sim.gateway.cancel(exchangeOrderId, { clOrdId: "C1-2" });
sim.gateway.expireDayOrders(ric?);       // what the session close does: EXPIRE live DAY orders

sim.gateway.getTopOfBook("AAPL.OQ");     // {bid, bidSize, ask, askSize, last, phase, seq}
sim.gateway.getOrder(exchangeOrderId);   // last ExecutionReport state
sim.gateway.getInstrument(ric); sim.gateway.isSimulated(ric); sim.gateway.getPhase(ric);
```

How execution reports are delivered:

- **Ordering.** Every report for a call, including the ack or reject, any immediate fills and the
  expiry of an IOC/FOK/market remainder, reaches listeners before the call returns. Reports arrive
  in FIFO order. A resting order filled later by bot flow gets its fills when that flow trades.
  Listeners may call back into the gateway, and those calls are queued.
- **Ids.** Exchange order ids are `X<n>`; `submit` returns one even for rejects. Exec ids are `E<n>`.
  A fill carries a `tradeId` that matches the `trades` table row, plus `liquidity` (`ADDED` when the
  order was the maker, `REMOVED` when it was the taker).
- **`execType` / `ordStatus`.**
  - `NEW` → `NEW`: the order was accepted.
  - `TRADE` → `PARTIALLY_FILLED` or `FILLED`, with `lastQty`, `lastPx`, `cumQty`, `leavesQty` and `avgPx`.
  - `REPLACED`: an amend was applied.
  - `CANCELLED`.
  - `EXPIRED`: an IOC or market remainder (`rejectReason` `NO_LIQUIDITY` for market orders), an FOK that could not fill (`FOK_NOT_FILLABLE`), or a DAY order at the session close (text `DAY order expired at market close`, no `rejectReason`).
  - `REJECTED` with a `rejectReason`.
- **New-order rejects** (`rejectReason`): `INVALID_REQUEST` covers tick, lot, qty, price/ordType
  mismatch and similar. The others are `DUPLICATE_CLORDID`, `UNKNOWN_INSTRUMENT`, `MARKET_CLOSED`,
  `INSTRUMENT_HALTED`, `PRICE_OUTSIDE_COLLAR`, `UNSUPPORTED_TIF` (IOC/FOK outside continuous) and
  `UNSUPPORTED_ORD_TYPE` (MARKET outside continuous).
- **Amend or cancel rejects.** If the order is unknown or already done, or the amend is invalid
  (including halted books, `INSTRUMENT_HALTED`, and a closed market, `MARKET_CLOSED`), you get a `REJECTED` report with `responseTo` `AMEND` or `CANCEL`. The
  order keeps its current `ordStatus` and is not changed.
- **Amends.** An amend may change the price and/or the total quantity, which must be ≥ `cumQty`. An
  amend down to `cumQty` reports `REPLACED` with status `FILLED`. An amend that crosses the book
  reports `REPLACED` followed by `TRADE`s. A quantity decrease at the same price keeps the order's
  time priority; a price change or quantity increase re-queues it at the back of its level. The
  `REPLACED` report's `priorityKept` says which applied.
- **Identification.** Gateway orders sit on the book with `accountId = account`,
  `owner = "gateway"` and `meta = clOrdId`, so they are distinguishable from bot orders.

## Performance

These numbers come from `bun run bench --subscribe` with default config (200 books) on an Apple
Silicon laptop, running through a real VuuServer:

| | |
| --- | --- |
| Book events (simulated) | ~13.8k/s (taker ~1.9k trades/s) |
| Table updates | ~21k/s (prices + depth deltas + trades) |
| Capacity, max mode | ~57k book events/s and ~88k table updates/s per wall second: about 4x headroom |
| Realtime event-loop lag | p50 1ms, p99 ~10ms; the websocket client receives ~4.4k rows/s on 3 viewports |

To reach the 5–20k events/s target band, keep the defaults or scale `activeInstruments` or `takerRate`.
