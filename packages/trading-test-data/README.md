# @heswell/trading-test-data

Server-free EXCHANGE and OMS data for the showcase, demos and UI tests. Instead of fake generators, it runs the
**real `@heswell/exchange-sim` and `@heswell/oms` engines in the browser** on
[`@heswell/vuu-data-engine-local`](https://www.npmjs.com/package/@heswell/vuu-data-engine-local). That library is a
browser Vuu engine with the same viewport, sort, filter, group, visual-link, edit-session and RPC behaviour as
vuu-server. Local data therefore matches the server:

- Every table publishes the exact `@heswell/trading-schemas` `TableSchema`:
  - EXCHANGE: `instruments`, `prices`, `depth`, `trades`, `instrumentPrices`
  - OMS: `accounts`, `parentOrders`, `childOrders`, `fills`, `positions`, `positionPrices`
- RPCs use the server handlers (`handleOmsRpc`, `handleExchangeAdminRpc`), so the same validation and
  `CODE: message` errors apply:
  - order RPCs: `createOrder`, `amendOrder`, `cancelOrder`, `cancelAll`
  - admin RPCs: `setVolatility`, `haltInstrument`, `resumeInstrument`, `setBotRate`, ...
- Market orders fill against bot liquidity and update `fills`, `positions` and `positionPrices`.
- Visual links come from the table definitions, e.g. depth/trades → instrumentPrices by `ric`.
- OMS rows are filtered per user via `omsService.accessFor`. Set the user with `setCurrentUser`.
- A `parentOrders` edit session amends and cancels through the OMS. Only quantity and price can be edited; adding
  rows is refused.

## Use

```ts
import { createTradingLocalServer, setCurrentUser } from "@heswell/trading-test-data";

setCurrentUser({ name: "admin", authorizations: [] }); // admin sees every account
const localServer = createTradingLocalServer(); // shared singleton, ticking
// <TradingDataProvider mode="local" localServer={localServer}>…</TradingDataProvider>   (@heswell/trading-ui)
```

Deterministic (tests):

```ts
const td = createTradingTestData({
  seed: 1,                       // same seed + manual clock => same market and orders
  manualClock: true,             // no timers; time moves only via advance()
  exchange: { activeInstruments: 10 },
  oms: { flowRate: 0 },          // no background orders
});
td.advance(2_000);               // build order books
const prices = td.exchange.createDataSource("instrumentPrices");
const result = td.rpc("createOrder", { account: "ACC-US-01", ric: td.sim.books[0].ric,
  side: "BUY", ordType: "MARKET", quantity: 100 });
td.dispose();                    // in afterEach
```

| API | |
| --- | --- |
| `createTradingTestData(options)` | Returns `{ exchange, oms, engine, sim, omsService, schemas, clock, running, start, stop, advance, rpc, dispose }`. |
| `options` | `seed`; `exchange` (exchange-sim config, default `activeInstruments: 50`); `oms` (OMS config); `manualClock`; `autoStart` (`"on-subscribe"` by default, or `true`/`false`). |
| `getTradingTestData()` / `resetTradingTestData()` | Process-wide singleton. |
| `createTradingLocalServer(testData?, connectionId = "trading")` | A `LocalVuuServer` for `@vuu-ui/core`, or for `TradingDataProvider mode="local"`. |
| `setCurrentUser` / `getCurrentUser` | engine-local user; drives OMS permissions. Seeded owners: alice (ACC-US-01), bob, carol, dave, erin. |
| `ManualClock`, `visualLinksFor`, `TradingLocalModule` | Lower-level building blocks. |

Notes:

- Each instance has its own engine-local `LocalEngine` (`td.engine`), so several can be live at once.
  `dispose()` releases its tables, timers and modules.
- No bundler shims are needed: the browser bundle runs the real engines as-is.
- This is a development and test dependency. Do not import it from `@heswell/trading-ui` sources or MF features.
- Tests: `bun run test:ui` (happy-dom preload).
