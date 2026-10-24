# Resilience: reconnect, resubscribe and stale data (Phase 5B)

How the trader front-end behaves when a connection drops, a server restarts, a token expires or the server refuses
a session, and the reusable pieces in `@heswell/trading-ui` that do it. Nothing here depends on server-side
persistence: after a restart the UI shows whatever state the server has.

## 1. What vuu-ui alpha.21 already does

| Layer | Behaviour on a dropped socket | Gaps |
| --- | --- | --- |
| `WebSocketConnection` (`@vuu-ui/vuu-data-remote`, in the worker) | `onclose` sets `disconnected` and closes; no reconnect of its own. Emits `websocket-open`, `connected`, `reconnected`, `disconnected`, `closed`. | Never emits `connecting` / `reconnecting` (the setter swallows them: trader upstream issue 82). Ignores close codes (trader upstream issue 73). An unrecognised login refusal (`maximum sessions (N) reached…`) is parsed as JSON, throws, and the pending login never settles (trader upstream issue 83). The open timeout throws inside `setTimeout` instead of rejecting (trader upstream issue 86). |
| `ServerProxy` (worker) | On `disconnected` clears every viewport's rows; on `reconnected` resubscribes every viewport it knows (same client ids). | Rows are cleared, not kept (trader upstream issue 88). |
| `ConnectionManager` | Per-connection status listeners. | `destroyConnection(id)` drops every status listener of the id, including other subscribers' (trader upstream issue 89). `asyncRequest` (RPC, menu) has no timeout, and a send while disconnected is dropped, so the promise never settles (trader upstream issue 81). |
| `VuuConnectionRegistry` (`@vuu-ui/core`) | Ref-counted connection per `connectionId`. After a drop, reconnects on `retryIntervals` (default 1, 2, 3, 5, 10, 30, 60, 120 s), exchanging a fresh token for each attempt, then the worker resubscribes the viewports. | No jitter; gives up after ~4 minutes and the module shows its error boundary. A *first* connect that fails is not retried at all (trader upstream issue 84). No per-attempt timeout, so a hung login stops the loop for good (issue 83). |
| `VuuServerMonitor` / `ConnectionLostOverlay` (`@vuu-ui/core`) | Marks a connection lost while it reconnects; the portal overlays and inerts the lost module. Probes again after a failed acquire. | — |
| `RemoteModule` / `AuthenticationProvider mode="vuu-connection"` | Acquires the module's connection from the registry. | An acquire failure is thrown to the module's error boundary ("An error occurred while creating the remote module"). |
| `PortalNav` / `PortalConnectionStatus` (`@vuu-ui/core/portal`, alpha.23) | The nav footer shows the worst connection, with a popover listing each connection, its state, retry time and impact, and a retry action. | — |
| `useDataSource` (`@vuu-ui/vuu-table`) | — | Throws "a resumed dataSource must have a tableSchema" if its effect re-runs while the viewport is still subscribing, e.g. a changed `onSelect` during a cold start or a resubscribe (trader upstream issue 87). |

## 2. What trader adds (`packages/trading-ui/src/connection`)

- **`reconnectPolicy.ts`**: `ReconnectPolicy` `{ initialDelayMs, maxDelayMs, multiplier, jitter, maxAttempts }`,
  default 1 s doubling to 30 s, 50% jitter (a delay `d` becomes a value in `[d/2, d]`), unbounded attempts.
  `reconnectSchedule(policy)` is an iterable that `VuuConnectionRegistry` accepts as `retryIntervals`, with fresh
  jitter per reconnect episode.
- **`createResilientConnectionRegistry(options)`**: a `VuuConnectionRegistry` for the portal host
  (`AuthenticationProvider registry={…}`) with:
  - the jittered, unbounded schedule (option `reconnect`);
  - a per-attempt timeout (`loginTimeoutMs`, default 20 s), and an attempt that fails as soon as the socket closes
    after opening but before LOGIN_SUCCESS (a refused login);
  - **retry of failed first connects** with the same backoff, instead of the module's error boundary. All
    acquirers of a connection (the module and `VuuServerMonitor`) share one wait, so each retry is one login; the
    failed attempt's reference is released first, so the half-open connection is destroyed before the next one.
    `authorization-denied` (403) is not retried. Unmounting the module while it waits ends the loop.
  - its states published to `connectionStateStore`.
- **`connectionStateStore`**: per-connection `{ state, attempt, nextAttemptAt, error, retry, since }`.
- **`ReconnectSupervisor`**: the same backoff loop for connections opened with `connectToVuuServer` (standalone
  apps, the showcase's "Remote server" mode), which do not go through the registry.
- **`useTradingConnectionStatus()` / `useVuuConnectionStatuses(ids?)`**: combine the socket status with the
  reconnect state into `connected | connecting | reconnecting | disconnected | failed | local`, plus `attempt`,
  `nextAttemptAt`, `error` and `retry`. Local (in-browser) data is always `local`. `TradingConnectionStateOverride`
  forces a state below it (tests, showcase).
- **`useStaleIndicator({ lastUpdate, staleAfterMs })` / `useStaleData(...)`**: whether a view's data is stale
  (disconnected, reconnecting, or no update for `staleAfterMs` measured on the client clock), and `staleProps`
  (`className`, `data-stale`, `data-stale-reason`) that grey the view out.
- **RPC timeouts** (`data/tradingRpc.ts`): `sendTradingRpc(ds, rpc, params, { timeoutMs, connectionState })` fails
  at once (nothing sent) with a `TradingRpcError` whose `transport` is `"disconnected"` when `connectionState` is
  not connected, and with `transport: "timeout"` after `timeoutMs` (default `DEFAULT_RPC_TIMEOUT_MS` = 10 s; the
  text says to check the blotter, since a late order may still have been accepted). `reason` is `INTERNAL_ERROR`;
  `transport` is unset for server rejects. Edit-session amends (`openOrderEditSession`, `editOrdersInSession`) do
  the same.
- **`useStableCallback(fn)`**: a stable callback for vuu `Table` props that feed `useDataSource`'s effect (issue 87).

## 3. Components

| Component | Behaviour |
| --- | --- |
| `ConnectionStatusIndicator` | Dot and label for the worst observed connection: Connected, Connecting…, Reconnecting…, Disconnected, Connection failed. While retrying with a known next attempt: "retry in Ns" and a "Retry now" button. Tooltip lists each connection. `data-connection-state` on the root. Used by stand-alone hosts (the showcase); the portal host uses `PortalConnectionStatus` in the nav footer instead. |
| `OrderTicket` | While not connected: submit disabled, F9 / Ctrl+Enter ignored, a banner ("Connection lost, reconnecting: orders cannot be sent", "Connecting to the trading server…", …), `data-connection-state` and `.tradingOrderTicket-blocked`. Re-enabled when connected. Local data is always enabled. |
| `PriceLadder` | Click-to-trade and cancel blocked while not connected; greyed while stale (`staleAfterMs` optional). |
| `InstrumentGrid`, `MarketDepth`, `TradeTape`, `PositionsView`, `FillsBlotter`, `OrderBlotter` | Greyed (`data-stale`) while disconnected / reconnecting. MarketDepth and PriceLadder also take `staleAfterMs` (a quiet book is not stale by default). Blotter actions (cancel, cancel all, amend) fail at once with a toast while disconnected. |

## 4. Behaviour per failure

| Failure | What the user sees | Recovery |
| --- | --- | --- |
| **Dropped socket** (network, server killed) | Indicator "Reconnecting…" (retry countdown in standalone mode), portal overlay on the module, ticking views greyed then emptied (the worker clears viewports, issue 88), ticket and ladder blocked, RPCs sent while down fail at once ("not connected … was not sent"), in-flight ones time out after 10 s, both with a toast. | Registry reconnects with backoff + jitter and a fresh token per attempt, never giving up. On LOGIN_SUCCESS the worker resubscribes every viewport; grids, ladder, depth and blotters repopulate from the server; indicator "Connected"; ticket re-enabled. |
| **Trading server restart** | As above, for the trading connection only; the portal stays connected. | As above. The restarted server has whatever state it has (no persistence needed): blotters show the server's orders, the ladder the new book. Old vuu tokens are invalid after a restart, which is fine since each attempt exchanges a new one. e2e: reconnected 2.5–6.6 s after the server came back. |
| **Portal restart** | Indicator "Reconnecting…" briefly; the trading modules keep ticking (they have their own connection). | Same reconnect loop for the portal connection. e2e: connected 0.8–2.5 s after the restart. |
| **Keycloak token expiry / refresh** | Nothing while connected: vuu-server checks the token only at LOGIN. | Every connect / reconnect attempt calls `KeycloakAuthHandler.getIdentityToken()` (`keycloak.updateToken(-1)`, a forced refresh) and exchanges it for a new vuu token, so an outage longer than the token lifetime still reconnects. If Keycloak is down the attempt fails and is retried. A 403 from the exchange stops retrying ("Connection failed"). If the Keycloak SSO session itself has ended, refresh keeps failing and the indicator keeps retrying: reload to log in again. |
| **Session limit** (`maxSessionsPerUser`, `reject-new`) | The extra tab's login is refused; it shows "Connecting…" with the next attempt time (no error page). Other tabs are unaffected. | It retries with backoff (shared by the module and the monitor, so one login per retry) and connects once a session is free. e2e: connected 1.5–2.8 s after the other tab closed, 3 refused attempts. Reconnects after a drop never trip the limit: the server frees the old session when its socket closes, and the registry destroys a failed connection before the next attempt. |

### Why `reject-new` stays

`evict-oldest` is still unsafe: vuu-ui ignores close codes, so an evicted tab reconnects a second later and evicts
the next one (trader upstream issue 73). Trader's backoff makes the ping-pong slower (1 s, 2 s, 4 s…, jittered) but
does not stop it. Not reconnecting on 4001/4003/4004 needs the close code, which the worker drops before the
registry sees it.

## 5. Configuration

| Setting | Where | Default |
| --- | --- | --- |
| Reconnect policy | `createResilientConnectionRegistry({ reconnect })`, `connectToVuuServer({ reconnect })` (`false` disables) | 1 s → 30 s, ×2, jitter 0.5, unbounded |
| Login timeout per attempt | `loginTimeoutMs` on both | 20 000 ms (0 disables) |
| RPC timeout | `sendTradingRpc(…, { timeoutMs })`, edit-session options | `DEFAULT_RPC_TIMEOUT_MS` = 10 000 ms |
| Stale after no updates | `staleAfterMs` on `useStaleIndicator` / `useStaleData` / `MarketDepth` / `PriceLadder` | off (only connection state) |
| Server session limit | `VUU_MAX_SESSIONS_PER_USER`, `VUU_SESSION_LIMIT_POLICY` (trading / portal confs) | 5, `reject-new` |

## 6. Testing

- Unit: `packages/trading-ui/__tests__/reconnect.test.ts` (policy, supervisor, state store, the registry's
  reconnect and first-connect retry with a fake client) and `resilience.test.tsx` (RPC fail-fast and timeout,
  indicator, ticket blocking, stale marking).
- e2e (opt-in, not in CI): `bun run e2e:resilience`. It needs Keycloak (`~/keycloak`) and Playwright's Chromium
  (`bunx playwright install chromium`). It builds, starts Keycloak, portal, trading, features and host (on the
  default ports, or all shifted by `E2E_PORT_OFFSET`, default 30, if any is busy), logs in as alice and:
  1. kills / restarts the trading server `--restarts=N` times (default 3; SIGKILL then SIGTERM), checking the
     indicator goes reconnecting → connected, the ticket is blocked then re-enabled, stale markers appear and
     clear, and the instrument grid repopulates and ticks;
  2. restarts the portal `--portal-restarts=N` times (default 1);
  3. checks no session-limit refusal was seen;
  4. restarts the trading server with `maxSessionsPerUser=1`, opens a second tab (refused, shows connecting, first
     tab unaffected), closes the first, and checks the second connects and populates with no error page
     (`--no-session-limit` skips this).

  `--no-build` reuses the last build, `--headed` shows the browser, `E2E_VERBOSE=1` streams server logs.
  Screenshots go to `.run/e2e-resilience-*.png`. The script stops only the processes it started.

## 7. Limits

- Rows are cleared while disconnected (the worker does it, issue 88), so a greyed view is briefly visible and then
  empty until the reconnect repopulates it.
- In the portal, the registry does not expose attempt / next-attempt for drop reconnects, so the indicator shows
  "Reconnecting…" without a countdown (it has one for first-connect retries and in standalone mode).
- A login that succeeds just after the 20 s timeout is abandoned; the server frees that session when the
  connection is destroyed.
- An expired Keycloak SSO session is retried rather than reported; reload to log in.
- Fixes for issues 81–89 belong upstream; the workarounds above can go when they land.
