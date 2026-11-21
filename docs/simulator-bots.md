# Simulator bots

The exchange simulator's trading bots: what they are, how they are monitored and visualised, how they are
controlled to get varied simulations, and the client algo bots that trade through the OMS.

| Area | What |
| --- | --- |
| [Bot framework](#bot-framework) | Bot interface, order port, ledgers, market signals, rosters |
| [Monitoring](#monitoring) | `sim-admin` role, `simBooks` and `bots` tables, Overview and Bots screens |
| [Market impact and charts](#market-impact-and-charts) | Impact model, history tables, Instrument screen, attributed fills and markouts |
| [Control and scenarios](#control-and-scenarios) | Admin RPCs, `simEvents`, scenario runner |
| [Exchange bot kinds](#exchange-bot-kinds) | Stressed maker settings and six directional / liquidity kinds |
| [Client algo bots](#client-algo-bots) | Personas sending TWAP / VWAP / POV parents through the OMS |

Not built: depth by owner (`botOrders`), auctions, a spoofer, a sector factor in the price model, liquidity-tier
rosters, `simEvents` markers on the charts, and BackgroundFlow folded into ClientFlow.

## The default market

- **Price model** ([PriceModel.ts](../packages/exchange-sim/src/engine/PriceModel.ts)): each
  instrument has a hidden fair value, a zero-drift geometric random walk (volatility 20–50% unless
  `defaultVolatility` is set), reflected inside ±`priceBandPct` of the reference price, with simulated
  time running at `timeScale`. Aggressive trades feed back into it through
  [market impact](#market-impact-and-charts).
- **Market makers** ([MarketMaker.ts](../packages/exchange-sim/src/engine/bots/MarketMaker.ts)):
  `mmPerInstrument` per instrument. Each has a half spread of 2–6 bps, level spacing of 1–3 bps and a
  base size of `baseNotionalUsd`. They quote `mmLevels` each side, skew the centre against inventory
  (one tick per 4 × base size, capped below the half spread), reconcile only the levels that no
  longer fit, top up levels under half their size, and churn at `mmRate` (shared by the makers).
- **Noise takers** ([NoiseTaker.ts](../packages/exchange-sim/src/engine/bots/NoiseTaker.ts)): three
  per instrument, one account each, sharing `takerRate` (scaled by the intraday volume curve when a
  session is configured). Mix: 58% market orders, 28% IOC limits 0–2 ticks through, 12% passive
  limits 0–5 ticks behind living about 2s, 2% sweeps of 3–5 levels. Size is exponential with a mean of
  0.6 × the maker base size. The side leans towards fair value by up to ±35%, which keeps the traded
  price on the random walk.
- **Background flow** ([BackgroundFlow.ts](../packages/oms/src/flow/BackgroundFlow.ts)): simulated
  traders entering orders through the OMS, so they appear in blotters. Exchange bots never go
  through the OMS.

## Bot framework

Code in [packages/exchange-sim/src/engine/bots](../packages/exchange-sim/src/engine/bots).

- **`Bot`** ([Bot.ts](../packages/exchange-sim/src/engine/bots/Bot.ts)): `id` (`<ric>/<localId>`),
  `localId`, `kind`, `account`, `port`, `params`, `step(ctx)`, `pull()`, `extraStats()`. The step
  context has `dt`, `now`, the bot's `rate` and the instrument's `signals`.
- **Kinds** are registered as a `BotKindDef`: `stage` (`quote` bots step before `take` bots), the
  `rateGroup` that drives it (`setBotRate` groups; an instrument's rate is split evenly across the
  group's bots), an order id prefix, how local ids and accounts are named, a `paramSpec` (name,
  type, min, max, unit, description; used for validation and the generic parameter editor) and `create`.
  Kind names are `SimBotKind` in trading-schemas, so the UI can list them.
- **`OrderPort`** ([OrderPort.ts](../packages/exchange-sim/src/engine/bots/OrderPort.ts)): a bot's
  only way into the book. It stamps the account and owner (`bot:<ric>/<localId>`), counts orders,
  modifies and cancels, is the `FillSink` for every bot order, records fills in the ledger and then
  passes them on, tracks the bot's resting orders (`pullAll`, `restingQty`), holds the pause flag and
  enforces the per-bot limits.
- **`BotLedger`** ([BotLedger.ts](../packages/exchange-sim/src/engine/bots/BotLedger.ts)): orders,
  modifies, cancels, fills (maker / taker), bought, sold, notional, position, average cost, cash,
  realised P&L, and unrealised P&L marked to a given price. Ledgers are saved in exchange snapshots
  (`BookState.bots`) and restored by local id; snapshots without them still restore.
- **`MarketSignals`** ([MarketSignals.ts](../packages/exchange-sim/src/engine/bots/MarketSignals.ts)):
  one per instrument, updated from the book at the start of each step: mid, mid EMAs over 1s / 10s /
  60s, realised volatility (bps per √s, 30s window), trade imbalance (10s) and the last trade price.
- **Rosters** ([roster.ts](../packages/exchange-sim/src/engine/bots/roster.ts)): the bots an
  instrument starts with. `defaultRoster` is the default market; config `extraBots`
  (`kind:count[@Sector]`) adds more. Each bot's generator is forked from the instrument by a hash of
  its local id, so adding or removing a bot leaves the others' random streams (and drawn parameters)
  unchanged.
- `sim.getBots(ric?)` lists bots; `SimulatedInstrument` has `bots`, `signals` and `baseQty`.

## Monitoring

- **Access.** `sim-admin` is a `trader-trading-server` role (`sim-admin-access` in the nav) for all
  simulator monitoring and control; the seeded `admin` user has it. `exchangeSim.permissionMode`
  (`auto` default, `strict` in `application.trading.conf`) gates the admin tables with a per-table
  permission filter ([simAdminAccess.ts](../packages/exchange-sim/src/modules/exchange/simAdminAccess.ts)),
  and the admin RPCs return `PERMISSION_DENIED` without the role. `auto` also lets in users with no
  roles, as the OMS does. `trading-test-data` serves the tables to everyone and its direct admin RPCs
  are unchecked.
- **Public market data stays anonymous**: no accounts on `trades` or `bookOrders`. Attribution only
  appears in admin tables.
- **Tables** (EXCHANGE module, admin only). `SimAdminPublisher` writes `simBooks` and `bots` every
  `simPublishIntervalMs` (1s; 0 turns the tables off) and `botParams` when it changes.
  - `simBooks`, one row per instrument: phase, halt reason, fair value, walk, mid, mid-to-fair gap (bps),
    spread (bps), volatility, realised volatility, drift, rates, activity, maker net inventory, trade and
    volume totals, and the impact columns (`impactOffsetBps`, `impactTodayBps`, `impactK`, `bandLow`,
    `bandHigh`). Realised volatility is annualised on the model's clock (`timeScale`), so it compares
    with `volatility`.
  - `bots`, one row per bot: the ledger, P&L in USD (via `usdPerPriceUnit`), resting orders and
    quantity per side, configured and effective rate (orders/s, smoothed), `paused`, and `extraStats`
    (maker skew, quote count).
  - `botParams`, one row per bot per parameter: value, min, max, unit (from `paramSpec`), `baseline`
    and `changed`.
  - Totals by instrument or kind use Vuu group-by.
- **trading-ui**: `SimBooksGrid` (sort by RIC, gap, spread, inventory or volume), `BotsGrid` (group by
  kind, RIC or account, summed positions and P&L) and `BotDetail` (stats, P&L sparkline, recent fills,
  bot actions and the parameter form). Selecting a row links the instrument.
- **Features**, in the Simulator palette group:
  - Simulator › Overview (130): `SimSessionStrip` (market phase, session clock, phase control),
    `simBooks` above bots by kind, `ScenarioRuns` and `SimEventsLog`.
  - Simulator › Bots (131): an Exchange bots and a Client bots section, with the detail panel.
  - Simulator › Instrument (132): see [below](#market-impact-and-charts).

## Market impact and charts

**Impact model.** `fair = walk × exp(transient)`. Each aggressive trade nudges fair value by
`s × k × (notional / $100k) × (σ / 30%)`, where `s` is +1 for a buy and −1 for a sell. A share
`impactPermanentShare` (about 0.3) goes into the walk; the rest is transient and fades with
`impactHalfLifeSec`.

- Hook: `ExchangeSimulator.#onTrade` calls `book.model.applyImpact`; fading happens in
  `PriceModel.step`, so only during continuous trading. The ±20% band applies to the combined value.
- Every aggressive trade counts the same way: bots, OMS orders, algo children. Volume is attributed to
  the aggressor's owner group from the trade's owner and account.
- **Calibration**, on by default: `k` is worked out per instrument once at startup so that impact
  supplies `impactVolShare` (default 0.25) of the short-horizon variance, and the walk's volatility is
  scaled down so charted volatility matches the setting (0.298 measured for 0.30). `k` is calibrated on
  the whole move, not only the permanent part: the transient part fades over 30 s, so over shorter
  horizons it adds about as much variance as a permanent move. At the defaults that is about 1.4 bps
  per $100k: a $1m one-sided order moves fair value about 14 bps, of which about 4 bps stays. Raise
  `impactVolShare` for bigger moves. `TAKER_FLOW_FACTOR` (4.8) is measured by
  `packages/exchange-sim/scripts/impactCalibration.ts`, which also checks the realised volatility.
- `k` is 0 when the configured `takerRate` is 0 (there is no flow to calibrate on). It stays fixed
  after startup, so a scenario with more flow really is more volatile.
- The band recentres on fair value at each session close, which also resets `impactTodayBps`. The
  impact state (transient part) and band centre are saved in snapshots.
- Tests that check exact prices, `trading-test-data` and the showcase pin impact to 0.
- Stability: under five times the default taker flow for 2 minutes, the median gap between mid and
  fair value stays under 15 bps (`__tests__/impact.test.ts`).

**History tables** (sim-admin only; see the
[exchange-sim README](../packages/exchange-sim/README.md#tables-module-exchange)):

- `simSamples`, history per instrument (like `bookSamples`): fair, walk, mid, bid, ask, buy and sell
  volume by owner group (makers, takers, OMS, other bots), maker inventory.
- `botHistory`: bot stats sampled every few seconds, for sparklines.
- `botFills` (ring buffer): trade id, instrument, bot (or `OMS:<account>`), side, price, size, maker
  or taker, markout 5s later.

**Instrument screen** (follows the linked instrument): `SimInstrumentChart` (fair / walk / quotes over
stacked signed volume by owner group, on its own axis with shared time), `SimInstrumentControls` beside
it, `BotsGrid followInstrument` for the instrument's bots, and `BotFillsTape`, the attributed tape.

## Control and scenarios

`SimControl` (`src/engine/control/SimControl.ts`) applies every admin action, from RPCs and scenario
steps alike, and records it as a `SimEvent` in `simEvents` (ring buffer of 1000: time, user, action,
target, details, scenario run). The basic RPCs (`setVolatility`, halt, resume, `setBotRate`,
`setMarketPhase`) go through it too, so they are logged.

**Admin RPCs** (all need `sim-admin`, return the affected instruments or bots, and follow
[exchangeAdminRpc.ts](../packages/exchange-sim/src/modules/exchange/exchangeAdminRpc.ts)):

| RPC | Effect |
| --- | --- |
| `setBotParams { ric?, kind?, botId?, name, value, overSecs? }` | Checked against `paramSpec`; `overSecs` ramps the change |
| `setInstrumentParams { ric?, volatility?, driftBpsPerHour?, impact… }` | `setVolatility` is a shortcut for volatility |
| `shiftFairValue { ric, bps, informedSecs? }` | News jump; `informedSecs` adds an informed trader |
| `pauseBots` / `resumeBots` / `pullQuotes` | For a bot, a kind, an instrument or everything |
| `addBot` / `removeBot` / `resetBotStats` | Manage an instrument's bots |
| `runScenario { name, rics?, args? }` / `stopScenario { runId, revert }` | Scenarios |

- **RPC params are flat** (Vuu allows only string, number and boolean): `setBotParams` sets one
  parameter per call; `addBot params` and `runScenario args` are JSON strings, `runScenario rics` is
  comma separated. Values are absolute or relative (`"x2"`, `"+3"`, `"-3"`), clamped to the spec's range.
- A paused bot is skipped and pulls its orders. Each bot's baseline is its params at creation.
- The roster (kind, params, paused per bot) and the model settings (drift, impact) are saved with
  each book's settings, in snapshots and the journal, so bot and drift changes survive a restart.

**Scenarios** are JSON files in `packages/exchange-sim/scenarios/`, run by `ScenarioRunner`
(`src/engine/control/ScenarioRunner.ts`):

```json
{ "name": "flash-crash", "targets": { "random": 1 }, "args": { "sellUsd": 5e6 },
  "steps": [
    { "at": "+0s",  "action": "setBotParams", "params": { "kind": "marketMaker", "halfSpreadTicks": "x3" }, "over": "10s" },
    { "at": "+5s",  "action": "addBot", "params": { "kind": "aggressiveSeller", "notionalUsd": "$sellUsd", "durationSecs": 20 } },
    { "at": "+12s", "action": "pullQuotes", "params": { "kind": "marketMaker" } },
    { "at": "+25s", "action": "halt" },
    { "at": "+55s", "action": "resume" },
    { "at": "+60s", "action": "revert" } ] }
```

- Times are relative (`+30s`) or session time (`"10:30"`). Targets are instruments, a sector or N
  random instruments; `args` make one file reusable and are referenced as `$name` or `${name}` (for use
  inside a string such as `"+${minutes}m"`).
- A run saves the settings it will touch; stopping with revert, or a `revert` step, restores them. A
  step that fails fails the run and reverts it.
- The runner keeps an action registry (`registerAction`). The OMS adds its actions (client bots, flow
  rate, client algo orders) when it runs in the same process (as in
  [oms/src/Main.ts](../packages/oms/src/Main.ts)), and `ScenarioRunner.onRevert` lets it undo them.
- Run start (with its baseline) and end are journaled; runs live at a restart are reverted and listed
  as `ABORTED`.
- Tables: `scenarios` (definitions), `scenarioRuns` (status, step, next step time, targets) and
  `simSession` (phase, next change, session clock, paused bots, running scenarios).
- Shipped scenarios: `calm`, `volatile-open`, `trending-day`, `liquidity-crunch`, `flash-crash`,
  `news-jump`, `client-liquidation`, `pension-programme`, `informed-client-news`.

**Control UI**: phase control and scenario runs on the Overview; `SimInstrumentControls` on the
Instrument screen (volatility, drift, impact, jump buttons with an "informed trader (30s)" toggle,
halt, per-kind rates, Add bot listing every kind, pause, resume and pull quotes); bot actions and an
editable parameter form built from `paramSpec` in `BotDetail`, with a "changed from baseline" marker
and Reset to baseline. Changes apply immediately; `simEvents` is the audit trail.

## Exchange bot kinds

The book supports limit, market, IOC / FOK / GTC, post-only and native stop orders, but not
icebergs. Each kind states which price it trades on: true fair (noise taker, informed trader), its own
lagged estimate (makers), or mid and EMAs (momentum, mean reversion). New kinds are off by default;
`extraBots` and scenarios add them. See the
[exchange-sim README](../packages/exchange-sim/README.md#market-model) for parameters.

| Kind | Behaviour |
| --- | --- |
| Stressed market maker (settings on the maker) | Spread and size scale with realised volatility; stops adding to oversized inventory, flattens with IOCs at a hard limit; pulls in a fast market, then requotes wide |
| `momentum` | EMA fast − slow; enter beyond a threshold; exit, stop-loss or time limit; capped position |
| `meanReversion` | Trades against the gap from a slow EMA (or fair value) |
| `aggressiveTrader` | A blunt metaorder: market orders or sweeps for a notional over a time, down to a floor |
| `stopLosses` | A population of stops around the price, clustered at round numbers; cascades with impact |
| `iceberg` | Shows a slice of a large order, refilled as a new order; fixed, pegged to the touch or to fair |
| `informed` | After `shiftFairValue`, trades towards the new value while the makers lag |

- **Maker settings** (all off by default, so the default market is unchanged): `fairHalfLifeSecs`
  and `flowSensitivityBps` (lag: the maker's estimate catches up with fair value, and trade imbalance
  nudges it; with any lag, the noise taker's lean costs the makers money, which the markouts show),
  `volSensitivity` / `maxWiden` (stress), `maxInventory` / `flattenAt`, `pullMoveBps` /
  `cooldownSecs`. Stress is realised volatility over the instrument's starting volatility, so raising
  volatility in a scenario counts as stress. The fast market check uses the 1 s mid average (the 10 s
  one kept re-triggering after a jump), and does not re-trigger while the maker is quoting wide after
  a pull (with no maker quotes, the thin book swings).
- **Stops are held by the bot**, not the book: the gateway, L3 publishing and persistence only know
  limit orders, and a bot-held stop that fires a market order has the same market effect.
- **Mean reversion crosses the spread by default.** Passive orders at the touch damped the bid-ask
  bounce and raised the return autocorrelation (+0.28 against a −0.08 baseline) instead of lowering
  it; crossing gives −0.14. `passive: true` gives the passive version.
- **Limits**: `maxPositionUsd` and `maxOrdersPerSec` on the directional kinds; a breach pulls and
  pauses the bot and logs `botLimitBreach` to `simEvents`.
- Tests (`__tests__/newBots.test.ts`, seeded): the stressed maker widens in high volatility (more
  than 1.5x the spread of a maker without it), pulls and requotes wide; inventory limits cap a
  seller's push; momentum raises the lag-1 autocorrelation of 5 s returns and mean reversion lowers
  it; stops deepen a sell-off by over 30%; the iceberg shows a slice at a time; the informed trader
  profits only while makers lag; limit breaches pause and log.

## Client algo bots

**`ClientFlow`** ([ClientFlow.ts](../packages/oms/src/flow/ClientFlow.ts)), next to BackgroundFlow, runs
personas ([clientPersonas.ts](../packages/oms/src/flow/clientPersonas.ts)) that send TWAP / VWAP / POV
parent orders through `engine.createOrder` as the account's owner, so risk, routing, positions,
slippage and Execution quality all apply and the orders show in blotters. There is no second algo
engine. See the [OMS README](../packages/oms/README.md#client-bots) for the settings and personas.

- **Persona settings**: arrival rate (`ordersPerMin`, per wall-clock minute to match the other bot
  settings; it follows the volume curve and stops while closed), strategy mix, size, duration (in
  session minutes), participation ranges, limit style, side mode (random, programme,
  position-reverting, momentum, informed), universe, maximum live parents, amend / cancel chance.
- **Starter personas**: pension (large VWAPs, one-sided programme), hedge fund (POV 10–20%, momentum),
  quant (many short TWAPs), liquidation (POV 25%, urgent), informed (ahead of a news jump).
- **Momentum** uses the day's move against the reference price, which the OMS has without tracking
  prices; **informed** uses the exchange's fair value through `connectClientFlowToSim`.
- **Sim clients desk**: `oms.clientAccounts` (default 5) accounts `CLIENT-01…`, $2m per order, $25m
  position; the background flow leaves them alone. `addClientBot` can take any enabled account.
- **Tables**: `clientBots` and `clientBotParams` (OMS, sim-admin only). Exchange-side attribution is
  by account (`OMS:<account>`), so with one account per bot the fills tape shows a client bot's fills.
  The parameter form is shared with exchange bots (`BotParamList`).
- **RPCs** `addClientBot`, `removeClientBot`, `setClientBotParams`, `pauseClientBots`,
  `resumeClientBots`, `submitClientAlgo`, `setFlowParams` (for BackgroundFlow); all are scenario
  actions, logged in `simEvents`, and a run's revert removes the bots it added and restores what it
  changed.
- Client bots are not persisted (they come back from `oms.clientBots`); their orders are.
- Tests (`packages/oms/__tests__/clientBots.test.ts`, seeded): configured bots send the right
  strategies and sides from the Sim clients accounts and trade; deterministic for a seed; the
  background flow leaves the desk alone; the RPCs (bad values refused, pause stops new parents,
  remove cancels working ones, sim-admin only); the three client scenarios, including revert. Plus
  table and permission tests in trading-test-data and UI tests.

## Conventions

- **Time units**: bot and impact settings in wall-clock seconds; session-time fields are explicit
  (`HH:MM`, algo `durationMins`); price-model volatility and drift are annualised and use `timeScale`.
- **Performance**: run `bun run --cwd packages/exchange-sim bench` before and after changing bots or
  the price model. Baseline (200 instruments, default roster): about 13,800 book events and 1,900
  trades per simulated second, about 4x headroom, no deferred steps, real-time p99 event-loop lag
  around 10–20 ms. New kinds and client bots are off by default, so they don't change it.
