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
// VuuServerConfig(...).withModule(ExchangeModule(sim)).withModule(OmsModule(oms))
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
| `src/modules/oms/*` | Vuu module: tables, RPC handler, edit session, permission filter. |

## Tables

These are the `trading-schemas` OMS tables: `accounts`, `parentOrders`, `childOrders`, `fills`, `positions`, plus the
`positionPrices` join (positions ⟕ EXCHANGE prices). EXCHANGE must be registered first.

- `accounts` is seeded with 3 desks, 5 traders and 7 accounts.
  - Each account has `maxOrderQty`, `maxOrderNotional` and `maxPositionNotional`.
  - `ACC-ASIA-03` is disabled.
  - Owners are `alice` (ACC-US-01), `bob` (ACC-US-02), `carol` (ACC-EU-01), `dave` (ACC-EU-02) and `erin` (ACC-ASIA-01..03).
  - `sam` is a supervisor with no accounts.
  - See `src/reference/accounts.ts`.
- `parentOrders` holds one row per client order, keyed by `orderId` (`O-<n>`).
  - Risk rejects are recorded here too: status `REJECTED` with `rejectReason` and `text`.
  - `version` increments on every applied amend.
- `childOrders` holds the exchange-facing order (`<orderId>-1`, routed 1:1) with the exchange `exchangeOrderId`.
- `fills` has one row per execution (`execId`), keyed by parent `orderId` and `childOrderId`.
- `positions` has one row per `account|ric`.

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
| `createOrder` | `account, ric, side, ordType, quantity, price?, timeInForce?, clOrdId?` | `{orderId, clOrdId, status}` | Status is the state after the synchronous exchange response: `NEW`, `PARTIALLY_FILLED`, `FILLED`, `EXPIRED` (unfilled IOC/FOK/market) or `PENDING_NEW` with gateway latency. A risk / exchange reject returns `ERROR_RESULT` **and** leaves a `REJECTED` row. A duplicate `clOrdId` or permission failure creates no row. |
| `amendOrder` | `orderId, quantity?, price?` | `{orderId, status}` | Status is `REPLACED`, or `PARTIALLY_FILLED` if the order already has fills, or `PENDING_REPLACE` with latency. Quantity must be at least `cumQty`. Risk is re-checked on the remaining quantity. |
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
| Exchange rejects | Price band, halted instrument and so on are passed through with the exchange's reason. |

### Blotter inline edit (edit session)

`parentOrders` supports the vuu edit-session RPCs (`beginEditSession` → `editCell` → `endEditSession`).
vuu-server 4.0.0 supplies the secure defaults: direct `editCell` on the live viewport, key / system / unknown
columns, rows hidden by the permission filter, other users' session viewports and sessions of sessions are all
refused, and values are type-checked. `OmsRpcHandler` only adds the trading rules through the protected hooks:

- `isEditableColumn`: only `quantity` and `price`, only on a `parentOrders` session table. `deleteRow` /
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
  session start. `getStaleColumns` is not overridden: `parentOrders` rows only change on order events (ack, fill,
  replace, cancel, reject, expire, all material to an amend), and nothing ticks on a timer.

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
| `validateOrder`: phase `HALTED` / `CLOSED`, tick, lot, price/TIF rules | `INSTRUMENT_HALTED` / `MARKET_CLOSED` / `INVALID_*` / ... |
| `quantity > maxOrderQty` | `EXCEEDS_MAX_QUANTITY` |
| Order notional (USD) > `maxOrderNotional` | `EXCEEDS_MAX_NOTIONAL` |
| Limit price outside ±`collarPct` of reference (last, else mid, else refPrice) | `PRICE_OUTSIDE_COLLAR` |
| Projected position notional > `maxPositionNotional` (only when the order increases exposure) | `EXCEEDS_MAX_NOTIONAL`. The text says "projected position". There is no dedicated code. |

- Account limits are in **USD**. Notional is converted with the instrument's `usdPerPriceUnit` (for example GBX
  prices are in pence). Table `notional` columns stay in instrument currency.
- Market orders are valued at the far touch, falling back to the reference price.
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

## Background flow

`BackgroundFlow` simulates other traders.

- Every `flowStepMs` it submits **through the OMS** (risk, routing and so on), at a total of about `flowRate` orders
  per second:
  - mostly passive limits near the touch, some marketable;
  - some IOC;
  - amends and cancels of its own working orders (`flowCancelRate`).
- Orders are placed for the owners of `flowAccounts` (default: all enabled accounts), so they appear in those traders'
  blotters.
- Working orders are capped at `flowMaxWorking`.
- It uses a seeded RNG (`oms.seed`).

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
| `restrictedRics` | `""` | Comma-separated restricted list. |
| `permissionMode` | `auto` | `auto` or `strict` (see above). |
| `gatewayLatencyMs` | 0 | Simulated one-way OMS↔exchange latency. More than 0 makes `PENDING_*` states visible. |

## Not done / deferred

- **TWAP / algo slicing.** Skipped. Routing is 1:1 parent → child. The parent/child tables and `childOrderId`
  plumbing allow N children later.
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
  - Inline edit is possible through the edit session (quantity/price only), or simply call `amendOrder`.
- **Statuses.** With latency 0 a request completes inside the RPC, so `PENDING_*` is rarely seen. Test with
  `OMS_GATEWAY_LATENCY_MS=200`.
- **Rows.**
  - Fills link to orders by `orderId`.
  - Positions are keyed by `account|ric`; use `positionPrices` for a live price column.
- **Users.** The blotter is already filtered server-side. Supervisors see more accounts.

## Tests

`bun test` in this package runs 68 tests:

| file | tests | covers |
| --- | --- | --- |
| orderState | 13 | State machine |
| positionMath | 6 | Position and P&L math |
| risk | 8 | Pre-trade risk |
| access | 4 | Permissions |
| config | 3 | Config |
| engine | 22 | Lifecycle, partial fills, amend/cancel races, IOC/FOK/market, end of day, positions. Uses a real exchange-sim with a manual clock and scheduler. |
| flow | 3 | Deterministic background flow |
| OmsModule | 14 | Over WebSocket against a real `VuuServer` with EXCHANGE + OMS: RPC → fill → rows, the join, amend/cancel, rejects, permission filtering, the edit session (amend / cancel, stale rows, edit validation, hidden rows and other sessions, strict mode). |
