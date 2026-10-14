# @heswell/trading-schemas

Single source of truth for the trading system's Vuu tables, domain enums, RPC
contracts and shared validation. Used by `exchange-sim`, `oms` (server),
`trading-ui` and `trading-test-data` (client/local).

```ts
// UI / local test data – no server dependency
import { prices, toTableSchema, RpcName, tradingRpcRequest } from "@heswell/trading-schemas";
// Server modules – builds @heswell/vuu-server TableDefs
import { createExchangeTableDefs, toServerJoinFactory } from "@heswell/trading-schemas/server";
```

## Defining tables once

Tables are plain data (`defineTable`), from which both shapes are derived:

| Consumer | Adapter | Output |
|---|---|---|
| vuu-ui / local data sources | `toTableSchema(def)`, `getTradingSchemas()` | `TableSchema` (as in `TABLE_META_RESP`) |
| vuu-server modules | `toServerTableDef(def)`, `createExchangeTableDefs()`, `createOmsTableDefs()` | `TableDef` (fresh instance per module) |
| vuu-server joins | `toServerJoinFactory(join, {permissionFunction?})` | factory for `ModuleFactory.addJoinTable` |

Row helpers: `RowOf<typeof prices>` (object row type), `toRowArray(def, partial)`
(positional row, missing columns default to `0`/`""`/`false`),
`fromRowArray`, `columnIndices`. Key helpers: `depthKey`, `positionKey`.

```ts
const ex = createExchangeTableDefs();
ModuleFactory.withNameSpace(EXCHANGE_MODULE)
  .addTable(ex.prices, (t) => new PricesProvider(t))
  .addJoinTable(toServerJoinFactory(instrumentPrices), serviceFactory)
  .asModule();
```

## Tables

### `EXCHANGE` module (exchange-sim)

| Table | Key | Columns |
|---|---|---|
| `instruments` | `ric` | description, isin?, currency, exchange (MIC), sector?, tickSize, tickBands?, lotSize, priceDecimals, refPrice, simulated |
| `prices` | `ric` | bid, ask, bidSize, askSize, last, lastSize, open, high, low, close (prev), volume, turnover, vwap, change, changePct, phase (`TradingPhase`), seq, timestamp |
| `depth` | `id` = `ric\|side\|level` | ric, side, level (0 = best), price, size, cumSize, orderCount, ownSize?, seq |
| `trades` | `tradeId` | ric, price, size, aggressorSide, timestamp, seq |

### `OMS` module

| Table | Key | Columns |
|---|---|---|
| `accounts` | `account` | name, desk, owner, currency, maxOrderQty, maxOrderNotional, maxPositionNotional, enabled |
| `parentOrders` | `orderId` | clOrdId?, trader, *order columns*, version, notional |
| `childOrders` | `childOrderId` | parentOrderId, exchangeOrderId?, *order columns* |
| `fills` | `execId` | orderId (parent), childOrderId, tradeId, account, trader, ric, side, quantity, price, notional, currency, liquidity, timestamp |
| `positions` | `id` = `account\|ric` | account, ric, quantity (net), boughtQty, soldQty, avgCost, markPx, marketValue, realizedPnl, unrealizedPnl, totalPnl, currency, lastUpdate |

*Order columns*: ric, side, ordType, timeInForce, quantity, price, stopPrice?,
status, cumQty, leavesQty, avgPx, lastQty, lastPx, account, currency,
rejectReason?, text?, created, lastUpdate.

`?` = optional: providers may leave the type default.

### Joins

| Join | Module | Definition |
|---|---|---|
| `instrumentPrices` | EXCHANGE | instruments ⟕ prices on ric (instrument grid) |
| `positionPrices` | OMS | positions ⟕ prices on ric, adds bid/ask/last/change/changePct/phase (live P&L). Cross-module: EXCHANGE must be registered first in the same VuuServer. |

### Visual links (child → parent)

depth.ric, trades.ric → prices / instrumentPrices; childOrders.parentOrderId →
parentOrders.orderId; fills.orderId → parentOrders, fills.childOrderId →
childOrders; parentOrders.account, positions.account → accounts.

## Enums

Values are the strings stored in table columns and sent in RPC params.

| Enum | Values |
|---|---|
| `Side` | BUY, SELL |
| `OrdType` | MARKET, LIMIT, STOP*, STOP_LIMIT* (*reserved, rejected) |
| `TimeInForce` | DAY, GTC, IOC, FOK |
| `OrdStatus` | PENDING_NEW, NEW, PARTIALLY_FILLED, FILLED, PENDING_CANCEL, CANCELLED, PENDING_REPLACE, REPLACED, REJECTED, EXPIRED |
| `ExecType` | PENDING_NEW, NEW, TRADE, PENDING_CANCEL, CANCELLED, PENDING_REPLACE, REPLACED, REJECTED, EXPIRED |
| `TradingPhase` | CLOSED, PRE_OPEN, OPENING_AUCTION, CONTINUOUS, CLOSING_AUCTION, POST_CLOSE, HALTED |
| `Liquidity` | ADDED, REMOVED, AUCTION |
| `BotType` | MARKET_MAKER, TAKER, ALL |
| `RejectReason` | INVALID_REQUEST, UNKNOWN_INSTRUMENT, UNKNOWN_ACCOUNT, ACCOUNT_DISABLED, UNKNOWN_ORDER, DUPLICATE_CLORDID, UNSUPPORTED_ORD_TYPE, UNSUPPORTED_TIF, MISSING_PRICE, INVALID_PRICE, INVALID_TICK_SIZE, INVALID_QUANTITY, INVALID_LOT_SIZE, EXCEEDS_MAX_QUANTITY, EXCEEDS_MAX_NOTIONAL, PRICE_OUTSIDE_COLLAR, RESTRICTED_INSTRUMENT, INSTRUMENT_HALTED, MARKET_CLOSED, NO_LIQUIDITY, FOK_NOT_FILLABLE, TOO_LATE_TO_AMEND, TOO_LATE_TO_CANCEL, ORDER_PENDING, PERMISSION_DENIED, INTERNAL_ERROR |

## Order status transitions

`ORDER_STATUS_TRANSITIONS` (+ `canTransition`, `assertTransition`,
`isTerminalStatus`, `isWorkingStatus`, `canAmend`, `canCancel`):

```
PENDING_NEW      -> NEW | REJECTED
NEW              -> PARTIALLY_FILLED | FILLED | PENDING_CANCEL | PENDING_REPLACE | CANCELLED | EXPIRED
PARTIALLY_FILLED -> PARTIALLY_FILLED | FILLED | PENDING_CANCEL | PENDING_REPLACE | CANCELLED | EXPIRED
REPLACED         -> (same as PARTIALLY_FILLED)
PENDING_CANCEL   -> CANCELLED | NEW | PARTIALLY_FILLED | REPLACED | FILLED | EXPIRED
PENDING_REPLACE  -> REPLACED | NEW | PARTIALLY_FILLED | FILLED | CANCELLED | EXPIRED
FILLED, CANCELLED, REJECTED, EXPIRED: terminal
```

Orders are always acked (NEW) before fills; IOC/FOK remainders and DAY orders
at close are EXPIRED; a cancel/replace reject returns to the working status
(`workingStatusFor(cumQty, amended)`); REPLACED is a working status (amended,
no fills).

## RPCs

Sent as `RPC_REQUEST` with `VIEWPORT_CONTEXT` (any viewport on a table of the
target module); registered server-side via `DefaultRpcHandler.registerRpc`.
Params are flat. Success → `SUCCESS_RESULT { data }`; failure → `ERROR_RESULT`
with `errorMessage = "<RejectReason>: <text>"` (`rpcError` / `parseRpcError`).

| RPC | Module | Params | `data` |
|---|---|---|---|
| `createOrder` | OMS | `account, ric, side, ordType, quantity, price?, timeInForce? (=DAY), clOrdId?, stopPrice?` | `{ orderId, clOrdId?, status }` |
| `amendOrder` | OMS | `orderId, quantity?, price?` (≥1 required; quantity is new total) | `{ orderId, status }` |
| `cancelOrder` | OMS | `orderId` | `{ orderId, status }` |
| `cancelAll` | OMS | `account?, ric?, side?` (ANDed) | `{ orderIds }` |
| `setVolatility` | EXCHANGE | `ric?, volatility` (annualised, 0–10) | `{ rics }` |
| `haltInstrument` | EXCHANGE | `ric, reason?` | `{ rics }` |
| `resumeInstrument` | EXCHANGE | `ric, auction?` | `{ rics }` |
| `setBotRate` | EXCHANGE | `ric?, bot? (=ALL), rate` (events/s, 0 pauses) | `{ rics }` |
| `setMarketPhase` | EXCHANGE | `phase` (`PRE_OPEN` \| `CONTINUOUS` \| `CLOSED`); forced until the next scheduled session change, `CLOSED` expires DAY orders | `{ rics }` |

```ts
// client
dataSource.rpcRequest?.(tradingRpcRequest(RpcName.CancelOrder, { orderId }, vpId));

// server
rpcHandler.registerRpc(RpcName.CreateOrder, ({ namedParams }) => {
  const parsed = validateRpcParams(RpcName.CreateOrder, namedParams);
  if (!parsed.ok) return rpcError(RejectReason.InvalidRequest, parsed.errors.join("; "));
  const reject = validateOrder(parsed.value, instrument, phase);
  if (reject) return rpcError(reject.reason, reject.text);
  return rpcSuccess(RpcName.CreateOrder, { orderId, status: OrdStatus.PendingNew });
});
```

### Validation

- `validateRpcParams(name, params)` – structural: types, enums, required fields,
  unknown keys rejected, numeric strings coerced. Built on a tiny combinator
  validator (`object`, `string`, `number`, `boolean`, `oneOf`, `optional`).
- `validateOrder(order, instrument, phase?)`, `validateAmend(...)`,
  `validateQuantity`, `validatePrice` – business rules shared by order ticket
  and OMS; return `{ reason, text }` or `undefined`.

### Tick / lot utilities

`TickSchedule = number | TickBand[]` (bands from `instruments.tickBands`,
e.g. `"0:0.001;1:0.005;10:0.01"`). `tickScheduleOf(instrument)`,
`tickSizeAt`, `isOnTick`, `roundToTick(price, schedule, "nearest"|"up"|"down")`,
`stepTicks(price, schedule, n)` (band-aware, for ladders and nudge buttons),
`ticksBetween`, `decimalsOf`, `isValidLot`, `roundToLot`.
