# @heswell/exchange-sim

A simulated exchange running inside a Vuu server. It keeps one limit order book per active instrument
(`@heswell/hft-limit-order-book`). Market-maker and noise-taker bots trade against those books, and a
GBM reference price drives them. The results are published to the `EXCHANGE` module tables defined in
`@heswell/trading-schemas`. An in-process gateway lets the OMS (Phase 2) trade on the same books.

```
src/
  reference/      instrument universe (336 listings, 9 venues, tick bands, lot sizes, ref prices)
  engine/         ExchangeSimulator, InstrumentBook, PriceModel, TradingSession, bots/ (Bot, OrderPort, BotLedger, MarketSignals, roster, MarketMaker, NoiseTaker)
  publish/        MarketDataPublisher (prices / depth deltas / trades ring buffer), BookL3Publisher (bookOrders / bookEvents), TradeRingBuffer
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
- `bun run --cwd packages/exchange-sim bench [--mode=max|realtime|both] [--seconds=10] [--subscribe] [--timers=off|sampled|all]`.
  `--timers` turns on the hot-path [metrics timers](../../docs/metrics.md); max mode then prints each timer's p50 / p99.

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
| `bookOrders` | `orderId` | Order-by-order (L3) book: one row per resting order (`ric`, `side`, `price`, open `size`, `entryTime`, `seq`, `priority`). Anonymous: no account or owner. Sort by side, price, then `priority`, for queue order (`entryTime` is in ms and can tie). `orderId` matches `childOrders.exchangeOrderId` for OMS orders. Writes are coalesced per flush. Off with `bookOrders=0`. |
| `bookEvents` | `ric\|seq` | The L3 event tape (off by default, `bookEvents=1`). Ring buffer of `bookEventsCapacity` rows. See [L3 data](#l3-order-by-order-data). |
| `instrumentPrices` | `ric` | A join of instruments and prices. |
| `bars` | `ric\|interval\|start` | OHLCV candles per instrument and `barIntervals` interval (`1s`, `1m`, `5m`), built from trades. The current bar updates in place on each flush; `barHistory` closed bars are kept per series (oldest deleted). Intervals are exchange-clock (wall) time; intervals with no trades are gaps. `barBackfill` seeds synthetic history at startup. |
| `bookSamples` | `ric\|time` | Every `bookSampleIntervalMs`, a snapshot of each book's published top 5 levels: bid/ask/mid, spreadBps, touch sizes, top-5 cumulative depth, imbalance. `bookSampleHistory` samples per instrument. |

See [docs/charting-data.md](../../docs/charting-data.md) for the chart data semantics.

**Sim-admin tables.** Only users with the `sim-admin` role see rows (see `permissionMode`). Public market data
stays anonymous; these tables carry the bots' identity. Published every `simPublishIntervalMs`.

| Table | Key | Contents |
| --- | --- | --- |
| `simBooks` | `ric` | One row per simulated book: phase, fair value, walk, transient impact and the day's permanent impact (bps), `k`, the price band, mid, gap to fair and spread in bp, model and realised volatility (both annualised), `mmRate` / `takerRate` / `activity`, trade imbalance, market-maker inventory, bot count, trades and volume. |
| `bots` | `botId` (`<ric>/<localId>`) | One row per bot: kind, account, position, average price, position and realised / unrealised / total P&L in USD, order / modify / cancel / fill counts, volume, traded notional, resting orders and quantities, its share of the instrument's rate and its measured orders/s, market makers' skew. |
| `botParams` | `botId\|name` | One row per bot parameter: value, type, min / max, unit, description, readOnly, and `baseline` (the value at creation) with `changed`. Written at startup and on each change. |
| `simSamples` | `ric\|time` | Every `simSampleIntervalMs`, per instrument: fair, walk, mid, bid, ask, transient impact, aggressive volume bought and sold by owner group (`mm`, `taker`, `oms`, `bot`) and net per group, market-maker inventory. `simSampleHistory` kept per instrument. |
| `botHistory` | `botId\|time` | Every `botHistoryIntervalMs`, per bot: position, total and realised P&L in USD, volume, orders. `botHistorySamples` kept per bot. |
| `botFills` | `tradeId\|M` / `tradeId\|T` | Both sides of every trade: party (bot id or `OMS:<account>`), owner group, kind, account, side, price, quantity, USD notional, liquidity, and the markout `markoutMs` later (bps, > 0 = a gain for that side). Ring buffer of `botFillsCapacity` rows. |
| `simEvents` | `id` (the seq as text) | Audit log of control actions: time, user (`scenario` for a run's steps), action, target, details (JSON), run id. Ring buffer of 1000 rows, written as they happen. |
| `scenarios` | `name` | Scenario definitions: description, step count, default targets and args. |
| `scenarioRuns` | `runId` | Runs since startup: status (`RUNNING`, `DONE`, `STOPPED`, `ABORTED`, `FAILED`), user, targets, args, steps done, next step time, reverted, error. |
| `simSession` | `session` | One row: market phase, next phase and when, forced (and until), scheduled, session clock (HH:MM), timeScale, paused bots, running scenarios. |

### L3 (order-by-order) data

`prices` is level 1 and `depth` is level 2. Level 3 comes from the books themselves: every operation in
`InstrumentBook` (bots and gateway) reports what it did to the resting book as `BookEvent`s. Each book numbers
its events with its own gap-free `seq`, starting at 1.

| Event | When | `size` | `leaves` |
| --- | --- | --- | --- |
| `ADD` | An order (or the unfilled rest of one) starts resting | shown size | = size |
| `EXECUTE` | A resting order trades; reported for the maker only, with `tradeId` | traded | what's left (0 = gone) |
| `REDUCE` | Amended down at the same price (keeps time priority) | removed | what's left |
| `DELETE` | Cancelled, expired, or an amend that loses priority | removed | 0 |

The incoming side of a trade (a market order, IOC, or the crossing part of a limit) gets no event, because it never
rests. An amend that loses priority (new price or larger size) is a `DELETE`, then any `EXECUTE`s if the new price
crosses, then an `ADD` if it still rests. A rejected amend sends nothing. A restore replaces the book without events:
`bookOrders` is rebuilt for that instrument, so a `bookEvents` consumer should re-read `bookOrders` after one.

Replaying `bookEvents` in `seq` order reproduces `depth` exactly; `__tests__/bookL3.test.ts` checks this with live bots.
`bookEvents` is unfiltered across instruments, so subscribe with a `ric` filter: one instrument sees about 90
events/s at the default load, against about 18k/s for the whole market.

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
  is reflected inside a band of ±`priceBandPct` around refPrice, recentred on fair value at each
  session close, and published prices are on the tick grid.
- **Market impact** (on by default). `fair = walk × exp(transient)`. Every aggressive trade (bot, OMS
  order or algo child) moves fair value by `k × (notional / $100k) × (volatility / 30%)` its way:
  `impactPermanentShare` (0.3) of the move goes into the walk, and the rest is transient and fades
  with `impactHalfLifeSec` (30 s, wall clock, only while trading). `k` is worked out per instrument
  once at startup so the default taker flow supplies `impactVolShare` (25%) of the variance, and the
  walk's volatility is scaled down to match, so charted volatility stays about the same (about 1.4 bps
  per $100k at the defaults; check with `scripts/impactCalibration.ts`). `k` stays fixed when rates
  change, so more flow means more volatility. `impactVolShare=0` turns impact off; trading-test-data
  does that so UI tests keep exact prices.
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
- **Bots.** Each instrument runs the bots of its roster (default: `mmPerInstrument` market makers and
  three noise takers). A bot only reaches the book through its `OrderPort`, which stamps the account
  and the owner `bot:<ric>/<local id>` (e.g. `bot:VOD.L/MM1`), receives every fill and keeps the
  bot's `BotLedger`: order counts, fills, position, average cost and realised / unrealised P&L. The
  ledgers are saved in snapshots. `sim.getBots(ric?)` lists them. Every bot has its own random
  generator forked from the instrument by its local id, and reads a shared `MarketSignals` (mid EMAs,
  realised volatility, trade imbalance) taken once per step. See
  [docs/simulator-bots.md](../../docs/simulator-bots.md) for the design and what comes next.
- **Market makers.** There are `mmPerInstrument` MMs (accounts and local ids `MM1..`) per instrument.
  Each quotes `mmLevels` per side on a tick grid around fair value, with a half spread of about 2–6 bps,
  level spacing of 1–3 bps, and inventory skew. They requote when fair value moves, by cancel/replace of
  only the levels that changed. `mmRate` adds random discretionary cancel/replace churn per second.
  Off by default, settable per maker: `fairHalfLifeSecs` makes the maker's fair-value estimate lag
  (and `flowSensitivityBps` leans it with trade imbalance), so news and informed flow cost the makers
  money; `volSensitivity` widens the spread (and shrinks size) as realised volatility rises above the
  instrument's normal level, up to `maxWiden`; `maxInventory` stops quoting the side that adds and
  `flattenAt` market-orders back to it; `pullMoveBps` pulls every quote when mid jumps that far from its
  1 s average, for `cooldownSecs`, then quotes twice as wide for as long.
- **Takers.** Three takers, one account each (`TAKER1..3`), share `takerRate`/s per instrument as
  Poisson arrivals: mostly market orders and aggressive IOC limits, plus passive limits and occasional
  multi-level sweeps.
- **Other bot kinds** (off by default; add them with `extraBots`, `addBot` or a scenario). Each trades
  as its own account, and counts as "other bots" in the flow attribution.

  | Kind (local id) | Behaviour |
  | --- | --- |
  | `momentum` (`MOM1..`) | Goes long or short `targetQty` when the 10 s mid average is `entryBps` over or under the 60 s one; exits when the trend fades under `exitBps`, after a `stopLossBps` adverse move, or after `holdMaxSecs`. Market orders in clips. |
  | `meanReversion` (`MR1..`) | Leans against the gap from the 60 s mid average (`anchor: ema`) or the true fair value (`anchor: fair`), up to `maxQty` at `fullBps`; unwinds under `exitBps`. Crosses the spread; `passive` joins the touch instead (which adds depth rather than pulling the price back). |
  | `aggressiveTrader` (`AGG1..`) | Buys or sells `notionalUsd` evenly over `durationSecs` with market orders, sweeps or IOCs; stops early after a `floorBps` move. Idle when done. |
  | `stopLosses` (`STOPS1..`) | `perSide` stop-losses `minBps`..`maxBps` either side of the price, a share (`clustering`) on round numbers. Held by the bot (not the book): a stop whose trigger the mid or last trade reaches fires a market order, so with impact one stop can set off the next. Topped up every `refreshSecs`. |
  | `iceberg` (`ICE1..`) | `totalQty` shown `displayQty` at a time; each slice that fills is replaced by a new order at the back of the queue. Pegged to a `fixed` price, the same-side `touch` or `fair` value, `offsetTicks` away. |
  | `informed` (`INF1..`) | While armed (`shiftFairValue` with `informedSecs`, or `alwaysOn`), buys or sells with IOCs no worse than fair value when the touch is `thresholdBps` through it, so it only trades while the makers lag. Unwinds when disarmed. |

  `momentum`, `meanReversion`, `aggressiveTrader` and `informed` take the order port limits
  `maxPositionUsd` and `maxOrdersPerSec` (orders, modifies and cancels, smoothed over 5 s): a breach
  pulls and pauses the bot and is logged in `simEvents` (`botLimitBreach`, user `limits`).
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
| `publishIntervalMs` | 60 | Table flush interval (ms). Keep it a multiple of vuu-server's 60 ms send cycle. |
| `depthLevels` | 10 | Depth levels per side. |
| `tradesCapacity` | 50000 | Trades ring buffer size. |
| `barIntervals` | `1s,1m,5m` | `bars` intervals (`<n>s\|m\|h\|d`); empty disables bars. |
| `barHistory` | 500 | Closed bars kept per ric and interval. |
| `barBackfill` | 1 | 1 = seed `barHistory` synthetic closed bars per series from the price model at startup. |
| `bookSampleIntervalMs` | 1000 | `bookSamples` interval (ms); 0 disables. |
| `bookSampleHistory` | 300 | Book samples kept per instrument. |
| `bookOrders` | 1 | 1 = publish the L3 `bookOrders` table; 0 = off. |
| `bookEvents` | 0 | 1 = publish every L3 event to the `bookEvents` tape; 0 = off. |
| `bookEventsCapacity` | 50000 | `bookEvents` rows kept across all instruments (oldest deleted). |
| `priceBandPct` | 0.2 | Static band around refPrice (±20%). |
| `timeScale` | 10 | Price-model time multiplier. |
| `defaultVolatility` | 0 | Annualised vol for all instruments (0 = per-instrument 20–50%). |
| `mmPerInstrument` | 2 | Market makers per book. |
| `extraBots` | `""` | Bots added to every roster: `kind:count`, or `kind:count@Sector` for one GICS sector, comma separated (e.g. `momentum:1,stopLosses:1@Energy`). |
| `mmLevels` | 5 | Quote levels per side per MM. |
| `mmRate` | 10 | MM discretionary churn events/s per instrument (0 = MMs paused). |
| `takerRate` | 8 | Taker orders/s per instrument (0 = off). |
| `baseNotionalUsd` | 20000 | Typical order / quote notional. |
| `impactVolShare` | 0.25 | Share of each instrument's variance from aggressive flow (market impact); 0 = no impact. |
| `impactPermanentShare` | 0.3 | Share of each impact move that is permanent. |
| `impactHalfLifeSec` | 30 | Half-life of transient impact (wall-clock seconds). |
| `sessionOpen` | `""` | Session open, `HH:MM` UTC (`EXCHANGE_SIM_SESSION_OPEN`). Set with `sessionClose`; both empty = always open. |
| `sessionClose` | `""` | Session close, `HH:MM` UTC (`EXCHANGE_SIM_SESSION_CLOSE`). Earlier than `sessionOpen` = overnight session. |
| `preOpenMinutes` | 0 | Minutes of `PRE_OPEN` before the open (`EXCHANGE_SIM_PRE_OPEN_MINUTES`). |
| `sessionDayMs` | 0 | Fast simulated day (`EXCHANGE_SIM_SESSION_DAY_MS`): the 24h schedule is compressed into this many ms of clock time (aligned to multiples of it since the epoch); open/close default to 08:00/16:30 when unset. 0 = real 24h day. |
| `volumeProfile` | `u` | Intraday volume curve the takers follow while a session is configured (`EXCHANGE_SIM_VOLUME_PROFILE`): `u` (busy open, quiet middle, busiest into the close) or `flat`. Published to the OMS through `gateway.getSessionSchedule()`; its VWAP follows the same curve. |
| `simPublishIntervalMs` | 1000 | `simBooks` / `bots` publish interval (ms); 0 disables the sim-admin tables. |
| `simSampleIntervalMs` | 1000 | `simSamples` interval (ms); 0 disables. |
| `simSampleHistory` | 300 | Sim samples kept per instrument. |
| `botHistoryIntervalMs` | 5000 | `botHistory` interval (ms); 0 disables. |
| `botHistorySamples` | 120 | Bot history samples kept per bot. |
| `botFillsCapacity` | 20000 | `botFills` rows kept (two per trade); 0 disables. |
| `markoutMs` | 5000 | `botFills` markout horizon (ms). |
| `permissionMode` | `auto` | Who sees the sim-admin tables and may call the admin RPCs: `strict` = only users with the `sim-admin` role; `auto` also lets in users with no roles at all (dev / permissive auth). |
| `volumeNoise` | 0.3 | Random variation of taker activity around the curve (`EXCHANGE_SIM_VOLUME_NOISE`, 0 = none): a per-day level and a slowly wandering component, each roughly ± this fraction, so actual volume differs from the forecast. |

Book events/s scale roughly linearly with `activeInstruments`, `takerRate` and `mmRate`.

Session examples: `EXCHANGE_SIM_SESSION_OPEN=08:00 EXCHANGE_SIM_SESSION_CLOSE=16:30
EXCHANGE_SIM_PRE_OPEN_MINUTES=30` for a real-time day, or `EXCHANGE_SIM_SESSION_DAY_MS=120000` for a
2-minute simulated day (08:00–16:30 scaled, i.e. ~42s open). The dev / e2e stacks configure no
session, so they are always open.

## Persistence

`ExchangeSimulator.exportState()` / `restoreState(state, journal)` / `setJournal(fn)` / `catchUpSession(lastActiveAt)`
make the books durable. Only customer (gateway) orders are kept, through hft-limit-order-book's `snapshot()`, in
time priority. Bots re-quote after a restore. Also kept: the trade-id counter (journaled in blocks of 1000, so ids
are never reused after a crash), the market phase and admin settings. A restart after a session close expires DAY
orders. The OMS's `TradingPersistence` drives it; see [docs/persistence.md](../../docs/persistence.md).

## Admin RPCs

Admin RPCs are registered on every `EXCHANGE` table (including `instrumentPrices`) through
`DefaultRpcHandler`. They need the `sim-admin` role (see `permissionMode`); others get `PERMISSION_DENIED`. Call them with an `RPC_REQUEST` in a `VIEWPORT_CONTEXT`. Params are validated
with `validateRpcParams`. Results follow the trading-schemas contract: `rpcSuccess({rics})`, or
`rpcError("<RejectReason>: text")`.

| RPC | Params | Notes |
| --- | --- | --- |
| `setVolatility` | `{ric?, volatility}` | Omit `ric` to apply to all books. |
| `haltInstrument` | `{ric, reason?}` | Sets phase to `HALTED`. |
| `resumeInstrument` | `{ric, auction?}` | Returns to the current market phase (`CONTINUOUS` unless the session is closed / pre-open); `auction: true` returns `INVALID_REQUEST` (auctions not implemented). |
| `setBotRate` | `{ric?, bot: MARKET_MAKER\|TAKER\|ALL, rate}` | Rate per instrument; 0 pauses. |
| `setMarketPhase` | `{phase: PRE_OPEN\|CONTINUOUS\|CLOSED}` | Forces the market-wide phase now (same transition logic, so `CLOSED` expires DAY orders) until the next scheduled change, or indefinitely when no session is configured. Halted books stay halted. Returns every simulated ric. |

Simulator control (all also recorded in `simEvents` with the caller's user name; bot selectors are
`{ric?, kind?, botId?}`, none = every bot):

| RPC | Params | Notes |
| --- | --- | --- |
| `setBotParams` | `{ric?, kind?, botId?, name, value, overSecs?}` | One parameter, checked against the kind's `paramSpec`. `value` is absolute or relative (`x2`, `+3`, `-3`), clamped to the range; `overSecs` ramps a number there linearly. |
| `setInstrumentParams` | `{ric?, volatility?, driftBpsPerHour?, impactBps?, impactPermanentShare?, impactHalfLifeSec?}` | Price model; omitted fields are unchanged. Drift is bps per hour of model time. |
| `shiftFairValue` | `{ric, bps, informedSecs?}` | A news jump of the walk, clamped to the band. `informedSecs` arms the instrument's informed traders (adding one if it has none) for that long. |
| `pauseBots` / `resumeBots` / `pullQuotes` / `resetBotStats` | bot selector | Paused bots pull their orders and stop; pull cancels resting orders now; reset zeroes P&L and counters, keeping the position. |
| `addBot` | `{ric, kind, params?}` | `params` is a JSON object of overrides. Returns `botId` too. |
| `removeBot` | `{botId}` | Pulls its orders and deletes its rows. |
| `runScenario` | `{name, rics?, args?}` | `rics` comma separated (default: the scenario's targets), `args` a JSON object. Returns `runId` too. |
| `stopScenario` | `{runId, revert?}` | Stops a live run; `revert` puts its targets' settings back (also on a finished run). |

Bot rosters, parameters, pause flags and drift are saved with the book settings (snapshot and journal).

Unknown or unsimulated rics give `UNKNOWN_INSTRUMENT`.

## Scenarios

JSON files in [scenarios/](scenarios/), listed in `scenarios/index.ts`: `calm`, `volatile-open`, `trending-day`,
`liquidity-crunch`, `flash-crash` (stressed makers, a stop-loss population and a $5m seller, then a halt) and
`news-jump` (lagging makers, a fair-value jump and an informed trader). A scenario has `name`, `description`, optional `targets` (`rics`, `sector`, `random` N, or all
simulated instruments), default `args`, and `steps` of `{at, action, params}`. `at` is `+30s` / `+2m` / `+500ms`
after the start, or session time `HH:MM`. `$name` / `${name}` in `at`, params or `targets.random` take the run's
args. Number params of `setInstrumentParams`, `setBotRate` and `setBotParams` take `x<f>` for a multiple of the
current value; `setBotParams` takes `over` (`"20s"`) to ramp.

Actions: `setInstrumentParams`, `setBotRate {bot, rate}`, `setBotParams {kind?, botId?, over?, <param>: value}`,
`shiftFairValue {bps, informedSecs?}`, `pauseBots` / `resumeBots` / `pullQuotes {kind?}`, `addBot {kind, count?, ...params}`,
`halt {reason?}`, `resume`, `setMarketPhase {phase}`, `revert`. Each applies to every target, or to `params.ric`.
A run saves its targets' settings first; a `revert` step, `stopScenario` with `revert`, a failed step or a restart
during the run put them back. More actions can be added with `sim.scenarios.registerAction`, and undone on a revert
with `sim.scenarios.onRevert`.

With the OMS in the same process (Main, trading-test-data), `connectClientFlowToSim` adds the client bot actions
`addClientBot {persona, count?, account?, ...params}` (trading the run's instruments unless `universe` is given;
`"all"` = every instrument), `setClientBotParams {botId? | persona?, <param>: value}`, `pauseClientBots` /
`resumeClientBots`, `submitClientAlgo {botId? | persona?, side?, notionalUsd?, strategy?, durationMins?,
participationPct?, limitBps?}` (one parent per target; adds a bot of the persona if there is none) and
`setFlowParams {rate?, notionalUsd?, maxWorking?, cancelRate?}`, and the scenarios `client-liquidation` (a $1.8m POV
25% seller), `pension-programme` (a one-sided VWAP programme across 5 names) and `informed-client-news` (lagging
makers, then a jump the informed client trades first). See the [OMS README](../oms/README.md#client-bots).

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
| Table updates | ~31k/s: prices + depth deltas + trades (~21k/s) plus bookOrders (~9k/s) |
| Capacity, max mode | ~57k book events/s per wall second: about 4.1x headroom (4.2x with `bookOrders=0`) |
| Realtime event-loop lag | p50 1ms, p99 ~10ms; the websocket client receives ~4.4k rows/s on 3 viewports |
| With `bookEvents=1` | ~65k table updates/s (the tape adds ~35k: an insert and an eviction per event); headroom about 3.8x, p99 lag ~11ms |

To reach the 5–20k events/s target band, keep the defaults or scale `activeInstruments` or `takerRate`.
