# Simulator bots

The plan for the exchange simulator's trading bots: how to monitor and visualise them, control them to
get varied simulations, let bots run algos, and add new kinds of bots. Phase 0 is built; the other
phases are a design and may change as they're built.

| Phase | What | Status |
| --- | --- | --- |
| 0 | Foundations: bot interface, order port, ledgers, market signals, rosters | Built |
| 1 | Monitoring grids: `sim-admin` role, `simBooks` and `bots` tables, Overview and Bots screens | Planned |
| 2 | Market impact, history charts, Instrument screen, attributed fills and markouts | Planned |
| 3 | Control: admin RPCs, `simEvents`, scenario runner | Planned |
| 4 | New exchange bots, each with the scenario it enables | Planned |
| 5 | Client algo bots in the OMS | Planned |

Later: depth by owner (`botOrders`), auctions, a spoofer, a sector factor in the price model, and
BackgroundFlow folded into ClientFlow.

## How the bots work today

- **Price model** ([PriceModel.ts](../packages/exchange-sim/src/engine/PriceModel.ts)): each
  instrument has a hidden fair value, a zero-drift geometric random walk (volatility 20–50% unless
  `defaultVolatility` is set), reflected inside ±`priceBandPct` of the reference price, with simulated
  time running at `timeScale`. Nothing anyone trades feeds back into it (until phase 2).
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

## Phase 0: foundations (built)

Code in [packages/exchange-sim/src/engine/bots](../packages/exchange-sim/src/engine/bots).

- **`Bot`** ([Bot.ts](../packages/exchange-sim/src/engine/bots/Bot.ts)): `id` (`<ric>/<localId>`),
  `localId`, `kind`, `account`, `port`, `params`, `step(ctx)`, `pull()`, `extraStats()`. The step
  context has `dt`, `now`, the bot's `rate` and the instrument's `signals`.
- **Kinds** are registered as a `BotKindDef`: `stage` (`quote` bots step before `take` bots), the
  `rateGroup` that drives it (`setBotRate` groups; an instrument's rate is split evenly across the
  group's bots), an order id prefix, how local ids and accounts are named, a `paramSpec` (name,
  type, min, max, unit, description; for validation and the generic UI editor later) and `create`.
- **`OrderPort`** ([OrderPort.ts](../packages/exchange-sim/src/engine/bots/OrderPort.ts)): a bot's
  only way into the book. It stamps the account and owner (`bot:<ric>/<localId>`), counts orders,
  modifies and cancels, is the `FillSink` for every bot order, records fills in the ledger and then
  passes them on, and tracks the bot's resting orders (`pullAll`, `restingQty`). Phase 4 adds per-bot
  limits here.
- **`BotLedger`** ([BotLedger.ts](../packages/exchange-sim/src/engine/bots/BotLedger.ts)): orders,
  modifies, cancels, fills (maker / taker), bought, sold, notional, position, average cost, cash,
  realised P&L, and unrealised P&L marked to a given price. Ledgers are saved in exchange snapshots
  (`BookState.bots`) and restored by local id; older snapshots without them still restore.
- **`MarketSignals`** ([MarketSignals.ts](../packages/exchange-sim/src/engine/bots/MarketSignals.ts)):
  one per instrument, updated from the book at the start of each step: mid, mid EMAs over 1s / 10s /
  60s, realised volatility (bps per √s, 30s window), trade imbalance (10s) and the last trade price.
- **Rosters** ([roster.ts](../packages/exchange-sim/src/engine/bots/roster.ts)): the bots an
  instrument starts with. `defaultRoster` is today's market. Each bot's generator is forked from the
  instrument by a hash of its local id, so adding or removing a bot leaves the others' random streams
  (and drawn parameters) unchanged.
- `sim.getBots(ric?)` lists bots; `SimulatedInstrument` has `bots`, `signals` and `baseQty`.

Behaviour is statistically unchanged. Two visible differences: the single taker with three accounts
is now three takers with one account each, and random streams per seed differ from before (bots no
longer draw from the instrument's generator), so exact prices for a given seed changed.

## Phase 1: monitoring grids

- **Access.** One `sim-admin` server role (plus `sim-admin-access` for the nav) for all simulator
  monitoring and control. The exchange module has no permission checks today; add viewport and RPC
  checks following [access.ts](../packages/oms/src/permissions/access.ts), the role in
  [keycloak-realm.ts](../scripts/stack/keycloak-realm.ts) and the realm export.
- **Tables** (EXCHANGE module, admin only):
  - `simBooks`, one row per instrument: phase, halt reason, fair value, mid, mid-to-fair gap (bps),
    spread (bps), volatility, realised volatility, rates, activity, maker net inventory, trades per
    minute. Phase 2 adds the walk and impact columns.
  - `bots`, one row per bot: the ledger, P&L in USD (via `usdPerPriceUnit`), resting orders and
    quantity per side, configured and effective rate, and `extraStats` (maker skew, quote count).
  - `botParams`, one row per bot per parameter: value, min, max, unit (from `paramSpec`).
  - Totals by instrument or kind use Vuu group-by.
- **Public market data stays anonymous**: no accounts on `trades` or `bookOrders`. Attribution only
  appears in admin tables.
- **Screens**, a new "Simulator" nav section (500s), each also a workspace panel:
  - Overview: market phase and session clock; `simBooks` grid (sort by gap, spread or inventory to
    find stressed instruments; selecting a row links the instrument); bots grouped by kind.
  - Bots: every bot, grouped by kind, instrument or account; a detail panel per bot with parameters
    (read-only until phase 3), stats and fills.

## Phase 2: market impact and charts

**Impact model.** `fair = walk × exp(transient)`. Each aggressive trade nudges fair value by
`s × k × (notional / $100k) × (σ / 30%)`, where `s` is +1 for a buy and −1 for a sell. A share
`impactPermanentShare` (about 0.3) goes into the walk; the rest is transient and fades with
`impactHalfLifeSec`.

- Hook: `ExchangeSimulator.#onTrade` calls `book.model.applyImpact`; fading happens in
  `PriceModel.step`, so only during continuous trading. The ±20% band applies to the combined value,
  and the transient part is saved next to `fair`.
- Every aggressive trade counts the same way: bots, OMS orders, algo children.
- **Calibration**, on by default: `k` is worked out per instrument once at startup from
  `impactVolShare` (default 0.25, the share of volatility that comes from flow), and the walk's
  volatility is scaled down so overall volatility is unchanged. For the defaults this gives about
  12 bps per $100k, so a $1m one-sided order leaves about 35 bps of permanent drift. `k` stays fixed,
  so a scenario with more flow really is more volatile.
- Recentre the price band on the previous close at each session roll.
- Tests that check exact prices, `trading-test-data` and the showcase pin impact to 0.
- A stability test: a long run of heavy taker flow must not drift away from fair value.

**Charts and tables.**
- `simSamples` (history per instrument, like `bookSamples`): fair, walk, mid, bid, ask, buy and sell
  volume by owner group (makers, takers, OMS, other bots), maker inventory.
- `botHistory`: bot stats sampled every few seconds, for sparklines.
- `botFills` (ring buffer): trade id, instrument, bot (or `OMS:<account>`), side, price, size, maker
  or taker, markout 5s later.
- **Instrument screen** (follows the linked instrument): fair / walk / mid with the bid-ask range;
  signed volume by owner group underneath (its own axis, shared time); bots on the instrument; the
  attributed tape.

## Phase 3: control and scenarios

**Admin RPCs** (all need `sim-admin`, return the affected instruments or bots, and follow
[exchangeAdminRpc.ts](../packages/exchange-sim/src/modules/exchange/exchangeAdminRpc.ts)):

| RPC | Effect |
| --- | --- |
| `setBotParams { ric?, kind?, botId?, params, overSecs? }` | Checked against `paramSpec`; absolute or relative (`"x2"`) values; `overSecs` ramps the change |
| `setInstrumentParams { ric?, volatility?, driftBpsPerHour?, impact… }` | `setVolatility` stays as a shortcut; drift is new in the price model |
| `shiftFairValue { ric, bps, informedSecs? }` | News jump |
| `pauseBots` / `resumeBots` / `pullQuotes` | For a bot, a kind, an instrument or everything |
| `addBot` / `removeBot` / `resetBotStats` | Manage an instrument's bots |
| `runScenario { name, rics?, args? }` / `stopScenario { runId, revert }` | Scenarios |

Every applied change goes into an admin `simEvents` table (time, user, action, target, details,
scenario run), which also marks the Instrument screen's charts.

**Scenarios** are JSON files in `packages/exchange-sim/scenarios/`:

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
  random instruments; `args` make one file reusable.
- A run saves the settings it will touch; stopping with revert, or a `revert` step, restores them.
- The runner keeps an action registry. The OMS adds its actions (flow rate, client algo orders) when
  it runs in the same process (as in [oms/src/Main.ts](../packages/oms/src/Main.ts)).
- Tables: `scenarios` (definitions) and `scenarioRuns` (status, step, next step time, targets).
- After a restart, runs that were live are marked aborted and reverted.
- Phase 3 ships the scenarios that phases 0–2 can support: calm, volatile open, trending day,
  liquidity crunch. Later phases add flash crash, news jump and algo day.

**Control UI**: phase control, pause all and Run scenario on the Overview; a controls panel on the
Instrument screen (volatility, drift, impact, jump buttons, halt, per-kind rates); row actions and Add
bot in the bots grid; an editable parameter form built from `paramSpec`, with a "changed from
baseline" marker. Changes apply immediately; `simEvents` is the audit trail.

## Phase 4: new exchange bots

The book supports limit, market, IOC / FOK / GTC, post-only and native stop orders, but not
icebergs. Shared pieces first:

- **Maker lag.** Makers quote around the true fair value, so nobody can pick them off. Add
  `fairHalfLifeSecs` (their estimate catches up with fair value; tiny default) and `flowSensitivity`
  (trade imbalance nudges the estimate). With any lag, the noise taker's lean costs the makers money
  all the time, which the markouts show.
- **Per-bot limits** in the order port: maximum position and order rate; a breach pulls and pauses
  the bot and is logged to `simEvents`.
- **Anchors**: each kind states which price it trades on: true fair (noise taker, informed trader),
  its own lagged estimate (makers), or mid and EMAs (momentum, mean-reversion).

| Kind | Behaviour |
| --- | --- |
| Stressed market maker (settings on the maker) | Spread and size scale with realised volatility; stops adding to oversized inventory, flattens with IOCs at a hard limit; pulls in a fast market, then requotes wide |
| Momentum | EMA fast − slow; enter beyond a threshold; exit, stop-loss or time limit; capped position |
| Mean-reversion | Trades against the gap from a slow EMA (or fair value), mostly passive at the extremes |
| Aggressive seller / buyer | A blunt metaorder: market orders or sweeps for a notional over a time, down to a floor |
| Stop-loss population | Resting stop orders around the price, clustered at round numbers; cascades with impact |
| Iceberg | Shows a slice of a large order, refilled as a new order; fixed, pegged to the touch or to fair |
| Informed trader | After `shiftFairValue`, trades towards the new value while the makers lag |

New kinds are off by default; named rosters (by sector or liquidity tier) and scenarios add them.
Order: signals and maker lag with the stressed maker; aggressive seller and stops (flash crash);
momentum and mean-reversion; iceberg; informed trader. Each kind gets a seeded headless test of the
effect it should have (momentum raises return autocorrelation, mean-reversion lowers it, a stop
cascade deepens a drawdown, the stressed maker widens in high volatility).

## Phase 5: client algo bots

- `ClientFlow` in `packages/oms/src/flow`, next to BackgroundFlow: personas that send TWAP / VWAP /
  POV parent orders through `engine.createOrder`, so risk, routing, positions, slippage and
  Execution quality all apply. No second algo engine.
- A seeded "Sim clients" desk (`CLIENT-01…`) with larger limits than the flow accounts (about $2m per
  order); a persona can use an existing trader account for demos.
- Persona settings: arrival rate (parent orders per session hour, following the volume curve),
  strategy mix, size, duration and participation ranges, limit style, side mode (random, programme,
  position-reverting, momentum, informed), universe, maximum live parents, amend / cancel chance.
- Starter personas: pension (large VWAPs, one-sided programme), hedge fund (POV 10–20%, momentum),
  quant (many short TWAPs), liquidation (POV 25%, urgent), informed (ahead of a news jump).
- An OMS `clientBots` table; OMS fills attributed by account on the exchange side; client and
  exchange bots as two sections of the Bots screen.
- OMS admin RPCs: `setClientBotParams`, pause / resume / add / remove, `submitClientAlgo`, and
  `setFlowParams` for BackgroundFlow; all are scenario actions.

## Conventions

- **Time units**: bot and impact settings in wall-clock seconds; session-time fields are explicit
  (`HH:MM`, algo `durationMins`); price-model volatility and drift are annualised and use `timeScale`.
- **Performance**: run `bun run --cwd packages/exchange-sim bench` before and after each phase.
  Phase 0 baseline (200 instruments): about 13,800 book events and 1,900 trades per simulated second,
  4.1x headroom, no deferred steps.
