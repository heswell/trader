# @heswell/oms

Order management system as a Vuu server module (`OMS`). It runs in the same `VuuServer` as the exchange
simulator's `EXCHANGE` module and trades through `sim.gateway` (in-process, see
[exchange-sim](../exchange-sim/README.md)).

```ts
const sim = createExchangeSimulator({ config: loadExchangeSimConfig(config) });
const oms = createOms(sim.gateway, {
  config: loadOmsConfig(config),
  rics: () => sim.books.map((book) => book.ric), // instruments for the background flow
});
// VuuServerConfig(...).withModule(ExchangeModule(sim)).withModule(OmsModule(oms)).withModule(OmsNotificationModule(oms))
```

- `apps/portal-config/src/start-trading.ts` runs EXCHANGE + OMS as the portal stack's trading server (keycloak auth with token exchange, `application.trading.conf`).
- Stand-alone (permissive auth over plain HTTP, `vuu.ssl=false`): `bun run --filter @heswell/oms start` gives
  `ws://localhost:8095/websocket-trading`, `http://localhost:8447/api/authn`.

## Layout

| path | what |
| --- | --- |
| `src/domain/orderState.ts` | Pure order state machine (`reduceOrder`) over `ORDER_STATUS_TRANSITIONS`. Illegal transitions throw `OrderStateError`. |
| `src/domain/positionMath.ts` | Pure position / P&L math (`applyFill`, `markPosition`). |
| `src/risk/preTradeRisk.ts` | Pure pre-trade risk checks. |
| `src/permissions/access.ts` | Roles to visible / tradable accounts. |
| `src/engine/OmsEngine.ts` | Transport-independent core: risk, routing, execution reports, positions. |
| `src/engine/OmsService.ts` | Engine + background flow + mark timer + table sink. `createOms(gateway, options)`. |
| `src/flow/BackgroundFlow.ts` | Simulated "other traders". |
| `src/flow/ClientFlow.ts`, `clientPersonas.ts` | Client bots: simulated clients sending algo orders. |
| `src/flow/simScenarios.ts` | Connects the client bots to an in-process exchange: fair value, control log, scenario actions. |
| `src/modules/oms/*` | Vuu module: tables, RPC handler, edit session, permission filter. |
| `src/notifications/OmsNotifier.ts` | Turns engine events into notifications: rejects, and risk-limit warnings / breaches. |
| `src/modules/notifications/OmsNotificationModule.ts` | vuu-server's generic `NOTIFICATIONS` module fed by `OmsNotifier`. |

## Tables

These are the `trading-schemas` OMS tables: `accounts`, `parentOrders`, `childOrders`, `fills`, `positions`, `pnlHistory`,
`accountPnlHistory`, `clientBots`, `clientBotParams`, plus the `positionPrices` join (positions ⟕ EXCHANGE prices).
EXCHANGE must be registered first.

- `accounts` is seeded with 3 desks, 5 traders and 7 accounts, plus the Sim clients desk (`SIM-CLIENTS`, owner
  `simclient`): `clientAccounts` accounts `CLIENT-01…` with $2m order and $25m position limits, for the client bots.
  - Each account has `maxOrderQty`, `maxOrderNotional` and `maxPositionNotional`.
  - `ACC-ASIA-03` is disabled.
  - Owners are `alice` (ACC-US-01), `bob` (ACC-US-02), `carol` (ACC-EU-01), `dave` (ACC-EU-02) and `erin` (ACC-ASIA-01..03).
  - `sam` is a supervisor with no accounts.
  - See `src/reference/accounts.ts`.
- `parentOrders` holds one row per client order, keyed by `orderId` (`O-<n>`).
  - Risk rejects are recorded here too: status `REJECTED` with `rejectReason` and `text`.
  - `version` increments on every applied amend.
  - Execution quality: `arrivalPrice` (mid at creation, else the reference price), `slippageBps` (avgPx vs arrival,
    positive = worse: buys above / sells below arrival), `timeToFirstFill` and `timeToComplete` (ms from creation;
    0 until it happens; `timeToComplete` only for `FILLED`).
  - Algo columns: `strategy` (`DMA` / `TWAP` / `VWAP` / `POV`), `algoStart` / `algoEnd` (clock times; 0 for DMA,
    `algoEnd` 0 = open-ended POV), `participationPct` (POV) and `targetQty` (what the schedule says should be
    filled by now; equals `quantity` for DMA). See [Algo orders](#algo-orders).
  - Stop columns: `stopPrice` (0 unless `STOP` / `STOP_LIMIT`) and `triggeredAt` (clock time the stop triggered;
    0 while waiting). See [Stop orders](#stop-orders).
- `childOrders` holds the exchange-facing orders (`<orderId>-<n>`) with the exchange `exchangeOrderId`: one for a
  DMA order, many for an algo order.
- `fills` has one row per execution (`execId`), keyed by parent `orderId` and `childOrderId`.
- `positions` has one row per `account|ric`.
- `pnlHistory` (`account|ric|time`) and `accountPnlHistory` (`account|time`) are P&L / exposure snapshots taken by the
  mark timer every `pnlHistoryIntervalMs`, `pnlHistoryLength` per key (oldest deleted). A position row is written only
  when its quantity, mark or realised P&L changed; account totals are in USD. Not persisted. See
  [docs/charting-data.md](../../docs/charting-data.md).
- `clientBots` (`botId`) and `clientBotParams` (`botId|name`) are the client bots and their parameters (see
  [Client bots](#client-bots)). Rows are for sim-admin users only (the exchange-sim `sim-admin` role, or no roles in
  `auto` mode), whatever accounts they can see.

## Notifications

`OmsNotificationModule(oms)` registers vuu-server's generic `NOTIFICATIONS` module with a `notifications` table
plus `account`, `ric` and `orderId` columns. Rows are filtered per user by `account`, as the OMS tables are, and
each row's audience is the account owner. `OmsEngine.observe()` feeds `OmsNotifier`:

| Event | topic | level | type | expires |
| --- | --- | --- | --- | --- |
| Parent order rejected | `orders` | ERROR | silent | 15 min |
| Stop triggered (order sent to the exchange) | `orders` | INFO | toast | 15 min |
| Position notional ≥ 80% of `maxPositionNotional` | `risk` | WARNING | toast | 30 min |
| Position notional ≥ `maxPositionNotional` | `risk` | ERROR | toast | 30 min |

The risk alert fires once per crossing (0.05 hysteresis before it can fire again). Fills are not published: the
background flow fills continuously. The provider sweeps expired rows every 15 s (`sweepIntervalMs`). The portal maps
`topic` to the modules whose `notificationTopics` claim it.

## RPCs

`createOrder`, `amendOrder`, `cancelOrder` and `cancelAll` are registered on every OMS viewport (`accounts`,
`parentOrders`, `childOrders`, `fills`, `positions`, `positionPrices`). The order ticket can call them from whatever OMS
viewport it has open.

- They are plain `RPC_REQUEST`s with a `VIEWPORT_CONTEXT`. Menu RPCs are not supported (see `docs/protocol-parity.md`).
- Params are validated with `validateRpcParams`, then `validateOrder` / `validateAmend` and pre-trade risk.
- Success is `{type: "SUCCESS_RESULT", data}` (the `RpcResponse` contract).
- Failure is `rpcError(reason, text)`, i.e. `{type: "ERROR_RESULT", errorMessage: "<RejectReason>: <text>"}`. Use
  `parseRpcError` to get `{reason, text}`.

| RPC | params | success `data` | notes |
| --- | --- | --- | --- |
| `createOrder` | `account, ric, side, ordType, quantity, price?, timeInForce?, clOrdId?, stopPrice?, strategy?, …` | `{orderId, clOrdId, status}` | A `STOP` / `STOP_LIMIT` returns `NEW` and waits in the OMS (see [Stop orders](#stop-orders)). Otherwise status is the state after the synchronous exchange response: `NEW`, `PARTIALLY_FILLED`, `FILLED`, `EXPIRED` (unfilled IOC/FOK/market) or `PENDING_NEW` with gateway latency. A risk / exchange reject returns `ERROR_RESULT` **and** leaves a `REJECTED` row. A duplicate `clOrdId` or permission failure creates no row. |
| `amendOrder` | `orderId, quantity?, price?, stopPrice?` | `{orderId, status}` | `stopPrice` only for a stop that has not triggered (`INVALID_STOP_PRICE` after). A waiting stop is amended at once (`REPLACED`). Otherwise status is `REPLACED`, or `PARTIALLY_FILLED` if the order already has fills, or `PENDING_REPLACE` with latency. Quantity must be at least `cumQty`. Risk is re-checked on the remaining quantity. |
| `cancelOrder` | `orderId` | `{orderId, status}` | Status is `CANCELLED`, or `PENDING_CANCEL` with latency. |
| `cancelAll` | `account?, ric?, side?` | `{orderIds}` | With no `account`, cancels the caller's own working orders. With `account`, cancels all working orders of that visible account (supervisor use). Orders with a request in flight are skipped. |

Errors to handle in the UI:

| reason | when |
| --- | --- |
| `INVALID_REQUEST` | Bad params, or an amend that changes nothing. |
| `PERMISSION_DENIED` | No `trading-execute` role, or the account is not visible to the user. |
| `UNKNOWN_ORDER` | The order id doesn't exist. |
| `TOO_LATE_TO_AMEND` / `TOO_LATE_TO_CANCEL` | The order is terminal. |
| `ORDER_PENDING` | A `PENDING_NEW` / `PENDING_CANCEL` / `PENDING_REPLACE` request is in flight. Retry when the row changes. |
| `DUPLICATE_CLORDID` | The `clOrdId` was already used. |
| `MISSING_STOP_PRICE` / `INVALID_STOP_PRICE` | A stop without `stopPrice`, off tick, already reached by the market, or amended after it triggered. |
| Exchange rejects | Price band, halted instrument and so on are passed through with the exchange's reason. |

### Blotter inline edit (edit session)

`parentOrders` supports the vuu edit-session RPCs (`beginEditSession` → `editCell` → `endEditSession`).
vuu-server 4.0.0 supplies the secure defaults: direct `editCell` on the live viewport, key / system / unknown
columns, rows hidden by the permission filter, other users' session viewports and sessions of sessions are all
refused, and values are type-checked. `OmsRpcHandler` only adds the trading rules through the protected hooks:

- `isEditableColumn`: only `quantity`, `price` and `stopPrice`, only on a `parentOrders` session table. `deleteRow` /
  `deleteSelectedRows` mean cancel. `addRow` is refused (use `createOrder`), and sessions can only be begun on
  `parentOrders`.
- `validateCellEdit`: `validateAmend` against the order and instrument, so `editCell` rejects a bad price or
  quantity immediately (`INVALID_PRICE: ...`).
- `canSaveSession`: the user must have trading-execute (`PERMISSION_DENIED: <user> may not trade`).
- `applySessionSave`: each changed row becomes `amendOrder` and each deleted row `cancelOrder`, as the saving user.
  - It returns `{results: [{orderId, action, status}]}`, or one `ERROR_RESULT` that lists the per-order failures.
    On failure vuu-server rolls back and keeps the session open; discard it with `endEditSession` (no save).
  - The live rows change only through execution reports.
- Stale rows (the order changed since the session began) fail with `stale update` unless `force: true`, and each
  stale row's `vuuMsg` is `stale:<orderId>:<columns>`. vuu-server compares every column of the snapshot taken at
  session start, except the algo progress column `targetQty` (`PARENT_ORDER_PROGRESS_COLUMNS`), which ticks on the
  algo timer. The other columns only change on order events (ack, fill, replace, cancel, reject, expire, all
  material to an amend).

## Algo orders

`createOrder` takes an optional `strategy` (default `DMA`). DMA sends one child straight to the exchange, as
before. `TWAP`, `VWAP` and `POV` are worked by the `AlgoContainer` (`src/algo/`), which re-slices every running
algo order on the algo timer (`algoSliceMs`).

- **Parameters.** `durationMins` (TWAP default 30; POV runs to the close when omitted), `endTime` (`HH:MM`; VWAP
  default the close) and `participationPct` (POV, required, 0–50). Times are *session* times: with a compressed
  exchange day (`sessionDayMs`) they are scaled to clock time. Created while the market is closed, an algo starts at
  the next open. A DAY order, and any VWAP, never runs past the close. Algo orders take DAY or GTC only.
- **Schedules** (`src/algo/strategies.ts`). TWAP: linear from start to end. VWAP: the share of the session's
  forecast volume between start and end, from the exchange's intraday volume curve (flat, so TWAP, when the market
  has no session schedule). POV: `participation / (1 − participation)` of the volume other traders do since the
  start (the exchange tape, less the order's own fills).
- **Slicing** (`src/algo/planSlice.ts`). Each slice keeps a passive LIMIT child at the near touch sized to the next
  slice of the schedule; crosses the spread with an IOC when more than 5% behind (and for any remainder in the last
  two slices); cancels children when ahead of schedule or when the touch moves away. Filled + working never exceeds
  the parent quantity, and children never trade through the parent limit. Children are not risk-checked again: the
  parent passed pre-trade risk at entry.
- **Parent state.** The parent's quantities are the sum of its children's fills; its status is set by the container,
  not copied from a child. Cancel: `PENDING_CANCEL` until the live children are out, then `CANCELLED`. Amend:
  `PENDING_REPLACE` until the live children are out, then `REPLACED` (or a replace reject if fills went past the new
  quantity meanwhile), and slicing resumes on the new figures. At the end time any remainder is cancelled and the
  parent is `EXPIRED` (`text` says how much was left); `endOfDay()` does the same for DAY algos.
- **Restart.** All algo state is on the parent row (`ParentOrder.algo`), so it is journaled and restored with it;
  `restoreState` re-registers running algos, and reconcile fixes up their children as for DMA.

## Stop orders

`STOP` and `STOP_LIMIT` are held by the OMS, as a broker does: the exchange (like most equity venues) only takes
`MARKET` and `LIMIT`, and rejects stop types with `UNSUPPORTED_ORD_TYPE`.

- **Entry.** `stopPrice` is required and must be on tick. A buy stop must be above the market price and a sell stop
  below it (last, else mid, else refPrice): `INVALID_STOP_PRICE`. A `STOP_LIMIT` also needs `price`, at or above the
  stop for a buy, at or below for a sell. Stops are DMA only (`UNSUPPORTED_ORD_TYPE` with a strategy) and DAY or GTC
  (`UNSUPPORTED_TIF` for IOC / FOK). Risk prices a `STOP` at its stop price. The limit collar does not apply:
  stops legitimately sit far from the market.
- **Waiting.** The parent is `NEW` with no child and `triggeredAt` 0. Amend (quantity, `price`, `stopPrice`) and
  cancel apply at once, with no exchange round trip.
- **Trigger.** Every tape trade is checked against the waiting stops: a buy triggers on a trade at or above its
  stop, a sell at or below. The check runs in a microtask, because the exchange reports a trade before it has
  finished the order that made it. The OMS then sets `triggeredAt`, publishes an INFO toast and sends the only child:
  `MARKET` DAY for a `STOP`, `LIMIT` at `price` with the parent's TIF for a `STOP_LIMIT`. From here it is a DMA order
  (`stopPrice` can no longer be amended). A child the exchange rejects (for example halted) expires the parent,
  since it cannot go back to waiting. A stop's fill can trigger the next stop (cascades).
- **Expiry.** A waiting DAY stop expires when a session close falls after it was entered (`sessionClosedSince`) or
  its market is `CLOSED`, checked on the algo timer, which also catches up after a restart. `endOfDay()` expires
  them too. GTC stops wait across days.
- **Restart.** `stopPrice` / `triggeredAt` are on the parent row, so they are journaled. `restoreState` re-registers
  the waiting stops.
- **Latency.** With gateway latency the trade reaches the OMS late, and the child reaches the exchange later
  still. A stop fills after the move that triggered it, as stops held by a broker do.

## Order state machine

`reduceOrder(state, event)` is pure and checks every transition against `ORDER_STATUS_TRANSITIONS`.

- Lifecycle: `PENDING_NEW → NEW → PARTIALLY_FILLED → FILLED`.
- Cancel: `→ PENDING_CANCEL → CANCELLED`.
- Amend: `→ PENDING_REPLACE → REPLACED`. On ack the order returns to `workingStatusFor(cumQty)`, so an amended order
  with fills reports `PARTIALLY_FILLED`.
- `REJECTED` and `EXPIRED` are terminal.

Races (all in the engine tests):

- A fill during `PENDING_CANCEL` / `PENDING_REPLACE` updates `cumQty` / `avgPx` and keeps the pending status.
- A fill that completes the order wins: the order goes to `FILLED`, and the late cancel/replace reject is ignored.
- A cancel/replace reject (`TOO_LATE_TO_CANCEL` and so on) restores the working status. It is returned synchronously
  when the gateway answers synchronously.
- Amends never reduce `quantity` below `cumQty`.
- An event that is illegal for the current state (for example a stale report after a terminal state) is logged and
  ignored, not applied.

## Pre-trade risk

Risk checks run in this order, and the first failure wins. Each returns a `RejectReason`.

| check | reason |
| --- | --- |
| Unknown account | `UNKNOWN_ACCOUNT` |
| Account disabled | `ACCOUNT_DISABLED` |
| Unknown instrument | `UNKNOWN_INSTRUMENT` |
| Restricted list (`oms.restrictedRics`) | `RESTRICTED_INSTRUMENT` |
| `validateOrder`: phase `HALTED` / `CLOSED`, tick, lot, price/stop/TIF rules | `INSTRUMENT_HALTED` / `MARKET_CLOSED` / `INVALID_*` / `MISSING_*` / ... |
| Stop already reached by the market (STOP / STOP_LIMIT) | `INVALID_STOP_PRICE` |
| `quantity > maxOrderQty` | `EXCEEDS_MAX_QUANTITY` |
| Order notional (USD) > `maxOrderNotional` | `EXCEEDS_MAX_NOTIONAL` |
| LIMIT price outside ±`collarPct` of reference (last, else mid, else refPrice) | `PRICE_OUTSIDE_COLLAR` |
| Projected position notional > `maxPositionNotional` (only when the order increases exposure) | `EXCEEDS_MAX_NOTIONAL`. The text says "projected position". There is no dedicated code. |

- Account limits are in **USD**. Notional is converted with the instrument's `usdPerPriceUnit` (for example GBX
  prices are in pence). Table `notional` columns stay in instrument currency.
- Market orders are valued at the far touch, falling back to the reference price. A `STOP` is valued at its stop
  price.
- The projected position counts the current position plus the remaining quantity of working orders on the same side
  plus this order.
- The OMS collar (default 10%) is tighter than the exchange band (20%).

## Positions and mark-to-market

- **Fills.** Each fill updates `qty`, `boughtQty`, `soldQty`, `avgCost` and `realizedPnl`, using average cost:
  - A reducing fill realises `(px - avgCost) × closedQty × sign`.
  - A flip resets `avgCost` to the fill price.
- **Mark.** Every `oms.markIntervalMs` (default 500 ms), each position gets `markPx` from last, else mid, else
  refPrice. The OMS then recomputes `marketValue = qty × markPx`, `unrealizedPnl = (markPx - avgCost) × qty` and
  `totalPnl`. This keeps the `positions` table self-contained (risk and P&L use it).
- **Live prices.** The `positionPrices` join (positions ⟕ EXCHANGE prices) gives the UI tick-by-tick bid/ask/last
  next to each position.
- P&L is in instrument currency.

Simulator control (sim-admin only, see [Client bots](#client-bots)), on the same viewports:

| RPC | params | success `data` |
| --- | --- | --- |
| `addClientBot` | `persona, account?, params?` (JSON object of overrides) | `{botId, account}` |
| `removeClientBot` | `botId` | `{botIds}`; its working parents are cancelled |
| `setClientBotParams` | `botId?` or `persona?`, `name, value` (absolute, or `x2` / `+3` for numbers) | `{botIds}` |
| `pauseClientBots` / `resumeClientBots` | `botId?` or `persona?` (neither = all) | `{botIds}` |
| `submitClientAlgo` | `botId, ric, side?, notionalUsd? \| quantity?, strategy?, durationMins?, participationPct?, limitBps?` | as `createOrder` |
| `setFlowParams` | `rate?, notionalUsd?, maxWorking?, cancelRate?` | the background flow's settings |

## Background flow

`BackgroundFlow` simulates other traders.

- Every `flowStepMs` it submits **through the OMS** (risk, routing and so on), at a total of about `flowRate` orders
  per second:
  - mostly passive limits near the touch, some marketable;
  - some IOC;
  - amends and cancels of its own working orders (`flowCancelRate`).
- Orders are placed for the owners of `flowAccounts` (default: all enabled accounts but the Sim clients desk), so they
  appear in those traders' blotters.
- `setFlowParams` changes `rate`, `notionalUsd`, `maxWorking` and `cancelRate` at run time.
- Working orders are capped at `flowMaxWorking`.
- It uses a seeded RNG (`oms.seed`).

## Client bots

`ClientFlow` simulates institutional clients. Each client bot is a persona trading one account; it sends TWAP / VWAP
/ POV parent orders **through `engine.createOrder`**, so risk, the algo container, positions, slippage and execution
quality apply as for any client order (there is no second algo engine).

- Arrivals are a Poisson stream at `ordersPerMin` (wall clock), scaled by the session's volume curve and stopped while
  the market is closed. An arrival adds a parent (up to `maxLive` working), or amends (`amendChance`, quantity ±30%) or
  cancels (`cancelChance`) a working one.
- Each parent: an instrument from `universe` (empty = all, a list of rics, or `sector:<name>`), a side from
  `sideMode`, a log-uniform notional in `minNotionalUsd…maxNotionalUsd` (capped by the account's limits), a strategy
  from `twapWeight` / `vwapWeight` / `povWeight`, a duration in `minDurationMins…maxDurationMins` (session minutes)
  and, for POV, a participation in `minPovPct…maxPovPct`. `limitBps` > 0 sets a limit that far through arrival
  (within the price collar); 0 sends a market parent.
- Side modes: `random`; `programme` (always `programmeSide`); `positionReverting` (leans against the account's
  position); `momentum` (with the day's move against the reference price, surer the bigger it is); `informed`
  (towards the exchange's fair value, only when the mid is `informedThresholdBps` away). A side that would take the
  position past 80% of the account's limit is skipped.

| persona | side mode | orders | size | strategy |
| --- | --- | --- | --- | --- |
| `pension` | programme (random side) | 1 / min, 6 live | $0.5m–2m | VWAP 30–120 min, limit 100 bps |
| `hedgeFund` | momentum | 2 / min, 5 live | $0.2m–1.5m | POV 10–20%, 10–60 min |
| `quant` | random | 8 / min, 10 live | $50k–300k | TWAP 2–10 min, limit 20 bps, 10% amend / cancel |
| `liquidation` | programme SELL | 0.5 / min, 2 live | $1m–2m | POV 25% market, 15–30 min |
| `informed` | informed (15 bps) | 6 / min, 3 live | $250k–1m | POV 20–30% market, 2–5 min |

- Bots start from `clientBots` (`persona:count`, e.g. `pension:1,quant:2`), or are added by `addClientBot` and
  scenarios. A new bot takes the least used `CLIENT-nn` account; `account` can name any enabled account instead (a
  trader's, for demos). Bot ids are `CB<n>`; the RNG is seeded from `oms.seed`.
- On the exchange its fills are attributed to `OMS:<account>` (`botFills`, Bot detail's fills tape).
- Client bots are not persisted: after a restart they come back from `clientBots`; their orders are restored as
  usual.
- `connectClientFlowToSim(oms, sim)` (Main and trading-test-data call it) gives informed bots the fair value and
  `sector:` universes the sectors, logs every client bot change in `simEvents`, and registers the scenario actions
  `addClientBot`, `setClientBotParams`, `pauseClientBots`, `resumeClientBots`, `submitClientAlgo` and
  `setFlowParams`. A run's revert removes the bots it added and puts back the settings it changed. It defines the
  scenarios `client-liquidation`, `pension-programme` and `informed-client-news` (see the
  [exchange-sim README](../exchange-sim/README.md#scenarios)).

## Permissions

Each OMS table and `positionPrices` has a Vuu permission function (`omsPermissionFunction`).

- It builds a `PermissionFilter("account", visibleAccounts)` per viewport from the logged-in user (`name` +
  `authorizations`).
- Users who can see everything get no row filter.
- Edit-session copies inherit the filter.
- RPCs re-check access per request.

| role (client roles of the trading server's keycloak client, `trader-trading-server` in this repo's stack) | effect |
| --- | --- |
| `trading-view` | See your own accounts (`accounts.owner == username`). |
| `trading-execute` | See your own accounts and create/amend/cancel orders for any visible account. Required to trade. |
| `trading-supervisor` | See every account on the desks where you own accounts, or all desks if you own none. Combine with `trading-execute` to act on them. |

No `trading-*` role:

- With `oms.permissionMode="auto"` (default; permissive dev auth grants no roles):
  - account owners see and trade their own accounts;
  - any other user sees and trades everything.
- With `strict`: the user sees nothing and cannot trade.

The portal stack (`bun run start:all`) runs the trading server with `strict`
(`apps/portal-config/application.trading.conf`); see docs/portal-integration.md "Users and roles".

## Config

Set in `application.conf` as `oms.<key>`, or with the env var `OMS_<UPPER_SNAKE>` (env wins). For example
`OMS_FLOW_RATE=0` turns the flow off.

| key | default | |
| --- | --- | --- |
| `seed` | 7 | Background flow RNG seed. |
| `flowRate` | 2 | Background orders/s, total. 0 disables the flow. |
| `flowAccounts` | `""` | Comma-separated accounts for the flow. Empty means all enabled accounts. |
| `flowNotionalUsd` | 25000 | Target notional of a flow order. |
| `flowMaxWorking` | 40 | Maximum working flow orders. |
| `flowCancelRate` | 0.25 | Chance a flow tick amends or cancels instead of adding. |
| `flowStepMs` | 100 | Flow timer interval. |
| `collarPct` | 0.1 | Limit price collar vs reference. |
| `markIntervalMs` | 500 | Position mark timer. 0 disables it. |
| `pnlHistoryIntervalMs` | 10000 | P&L history sample interval (aligned). 0 disables `pnlHistory` / `accountPnlHistory`. |
| `pnlHistoryLength` | 180 | Samples kept per position / account (30 min at the default interval). |
| `restrictedRics` | `""` | Comma-separated restricted list. |
| `permissionMode` | `auto` | `auto` or `strict` (see above). |
| `gatewayLatencyMs` | 0 | Simulated one-way OMS↔exchange latency. More than 0 makes `PENDING_*` states visible. |
| `algoSliceMs` | 250 | Algo timer: how often TWAP / VWAP / POV orders are re-sliced. |
| `clientAccounts` | 5 | Accounts of the Sim clients desk (`CLIENT-01…`). 0 = none. |
| `clientBots` | `""` | Client bots started with the OMS, `persona:count` comma separated. |

### Persistence

`persistence.<key>` / `PERSISTENCE_<KEY>` / `TRADER_PERSISTENCE_<KEY>` (`store` = `memory` (default) | `file` |
`sqlite`, `dir`, `fsync`, `snapshotIntervalMs`, `snapshotEveryEntries`, `reset`, `cancelOrphans`). With a durable
store, `Main` recovers the exchange and OMS state before the tables attach, journals every change, and snapshots
periodically and on shutdown. `createTradingPersistence` (`@heswell/oms/persistence`) wires it for other servers
(the `start:all` trading server). See [docs/persistence.md](../../docs/persistence.md).

## Not done / deferred

- **DAY expiry at close.** With a configured exchange-sim trading session (`sessionOpen` / `sessionClose`, or
  `sessionDayMs` for a fast simulated day; see the exchange-sim README), the exchange expires working DAY orders at
  its close and the OMS records the `EXPIRED` reports. New orders are rejected with `MARKET_CLOSED` while closed.
  - By default no session is configured and the market is always open.
  - `oms.engine.endOfDay()` still expires working DAY orders on demand: it cancels them at the exchange and records
    them as `EXPIRED`.
  - IOC / FOK / unfilled market orders expire through exchange `EXPIRED` reports.
- **Account limit editing.** The `accounts` table is read-only seed data. There is no RPC for it.

## Notes for the UI (Phase 3)

- **Ticket.**
  - Call `createOrder` from any OMS viewport, ideally with your own `clOrdId` for idempotency.
  - Show `parseRpcError(errorMessage)`.
  - A rejected order also appears in the blotter as `REJECTED` with `rejectReason` and `text`.
- **Blotter actions.**
  - Enable amend/cancel only for `NEW` / `PARTIALLY_FILLED` / `REPLACED` rows.
  - Disable them while `PENDING_*` (the server returns `ORDER_PENDING`).
  - Inline edit is possible through the edit session (quantity / price / stopPrice only), or simply call `amendOrder`.
- **Statuses.** With latency 0 a request completes inside the RPC, so `PENDING_*` is rarely seen. Test with
  `OMS_GATEWAY_LATENCY_MS=200`.
- **Rows.**
  - Fills link to orders by `orderId`.
  - Positions are keyed by `account|ric`; use `positionPrices` for a live price column.
- **Users.** The blotter is already filtered server-side. Supervisors see more accounts.

## Tests

`bun test` in this package runs 94 tests:

| file | tests | covers |
| --- | --- | --- |
| orderState | 13 | State machine |
| positionMath | 6 | Position and P&L math |
| risk | 8 | Pre-trade risk |
| access | 4 | Permissions |
| config | 3 | Config |
| engine | 22 | Lifecycle, partial fills, amend/cancel races, IOC/FOK/market, end of day, positions. Uses a real exchange-sim with a manual clock and scheduler. |
| flow | 3 | Deterministic background flow |
| notifications | 5 | `OmsNotifier`: one reject row, one stop-triggered toast, risk warn / breach / hysteresis, unknown accounts, `engine.observe`. |
| stops | 9 | Stop orders against a real exchange-sim: wait and trigger (STOP → MARKET, STOP_LIMIT → LIMIT), entry rejects, amend / cancel while waiting, a rejected child, DAY expiry at end of day / close, restart, cascades. |
| OmsModule | 16 | Over WebSocket against a real `VuuServer` with EXCHANGE + OMS: RPC → fill → rows, the join, amend/cancel, rejects, permission filtering, the edit session (amend / cancel, stale rows, edit validation, hidden rows and other sessions, strict mode), a reject reaching the owner's `notifications` with `topic=orders`. |
| session | 3 | Exchange trading session: DAY expiry at the close, `MARKET_CLOSED`, `endOfDay`. |
| persistence | 16 | Restart from memory / file stores (graceful and crash), fill replay from exec reports, idempotence, reconcile (lost requests, orphans), DAY expiry while down, session / admin state, compaction, `kill -9` of a child process, config, reset. See [docs/persistence.md](../../docs/persistence.md#tests). |
| persistenceServer | 1 | A real `VuuServer` on a file store: order and partial fill over WebSocket, stop, a new server recovers the rows, and the order then fills. |
