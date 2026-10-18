# Portal integration and the trader workspace

How the trading UI (`@heswell/trading-ui`) is delivered through vuu-portal: as module-federation (MF) features,
registered with the portal server, gated by roles, and composed into a prebuilt trader workspace. One command runs
the whole stack.

```sh
bun run start:all          # first run builds the host + features (≈30 s); then open http://localhost:5100
```

Log in as `alice` / `password` (see [Users and roles](#users-and-roles)).

## Architecture

```mermaid
flowchart LR
  subgraph Browser
    Host["portal host :5100<br/>PortalShell, auth, nav<br/>(apps/portal-host)"]
    subgraph Remotes["MF remotes :5110/&lt;feature&gt;/<br/>mf-manifest.json + config.json"]
      WS[Workspace] --> WT[Workspace ticket]
      WS --> WL[Workspace ladder]
      W[Watchlist]
      D[Depth]
      O[Orders / Fills / Positions / Tape / Ticket / Ladder]
      SV[Supervision]
    end
    Host -- "loads mf-manifest.json,<br/>reads config.json" --> Remotes
    Bus(("instrument link bus<br/>+ BroadcastChannel"))
    Remotes <--> Bus
  end
  KC["Keycloak :8180<br/>realm vuu"]
  subgraph Portal["portal Vuu server (stock vuu-portal)"]
    REST["REST :8543<br/>/api/authn, module registry"]
    WSS["WebSocket :8191<br/>/websocket-portal"]
    MD[MODULE_DISCOVERY]
  end
  subgraph Trading["trading Vuu server (start-trading.ts)"]
    TREST["REST :8544<br/>/api/authn (token exchange)"]
    TWSS["WebSocket :8192<br/>/websocket-trading"]
    EX["EXCHANGE<br/>(exchange-sim)"]
    OMS[OMS]
  end
  Host -- "OIDC login (client vuu-portal)" --> KC
  Host -- "token, modules for my nav roles" --> REST
  Host --- WSS
  WSS --- MD
  Remotes -- "portal token" --> TREST
  TREST -. "token exchange →<br/>trader-trading-server" .-> KC
  Remotes -- "viewports, RPCs<br/>(connection &quot;trading&quot;)" --> TWSS
  REST -. "verifies token" .-> KC
  TWSS --- EX & OMS
  EX <--> OMS
```

| Part | Where | Source |
| --- | --- | --- |
| Keycloak (realm `vuu`, clients, roles, seeded users) | `https://localhost:8180` (http 8181, management 9100) | `scripts/stack/keycloak-realm.ts`, `infra/keycloak/realm-vuu.json` |
| portal Vuu server (module registry) | `wss://localhost:8191/websocket-portal`, `https://localhost:8543` | `apps/portal-config/application.conf`, stock `@heswell/vuu-portal` (`bunx vuu-portal --config apps/portal-config/application.conf`) |
| trading Vuu server (EXCHANGE + OMS) | `wss://localhost:8192/websocket-trading`, `https://localhost:8544` | `apps/portal-config/application.trading.conf`, `src/start-trading.ts` |
| portal host (PortalShell) | `http://localhost:5100` | `apps/portal-host` |
| trading features (12 MF remotes) | `http://localhost:5110/<feature>/` | `apps/features/trading` |

### Two Vuu servers

The portal server only authenticates the user and serves the module registry. The trading tables (exchange-sim
and OMS) run in a separate process, the **trading server**. Each feature remote publishes a `config.json` next to
its `mf-manifest.json` (a @vuu-ui 4.0.0-alpha.21 mechanism):

```json
{
  "connectionId": "trading",
  "restUrl": "https://localhost:8544/api/authn",
  "websocketUrl": "wss://localhost:8192/websocket-trading"
}
```

`RemoteModule` reads it before mounting the remote:

1. It POSTs the user's `vuu-portal` access token to `restUrl`.
2. The trading server exchanges the token with Keycloak (standard token exchange) for a token of its own
   confidential client `trader-trading-server`, which carries the trading roles. It then returns a Vuu session
   token.
3. `RemoteModule` opens a websocket connection `trading` with that token. The connection is shared, ref-counted,
   by every remote with the same `connectionId`. It wraps the remote in an `AuthenticationProvider` scoped to that
   connection, so the trading-ui data sources and `useVuuAuthorizations()` use the trading session without any
   code changes.

`scripts/features/build.ts` writes `dist/<feature>/config.json` from the `TRADER_*` variables below, and the
features server (`scripts/stack/serve.ts`) regenerates it on every request from its own environment. To point the
remotes at a trading server elsewhere, set `TRADER_TRADING_REST_URL` and `TRADER_TRADING_WEBSOCKET_URL`.
`RemoteModule` treats a missing `config.json` as an error, so every remote must publish one (`{}` means "use the
portal server"; trader upstream issue 57).

There is no proxy. The host fetches the remotes directly, and the features server sends CORS headers. The
vuu-portal client in finos/vuu uses no haproxy either.

The host can be opened at `http://localhost:5100` or `http://127.0.0.1:5100`. Both Vuu servers list both origins
(and the features server's) in `vuu.auth.cors.allowedOrigins`, and the realm's vuu-portal client has both as
redirect URIs. With other `TRADER_*` ports or hostname, `start:all` passes the derived list as
`VUU_CORS_ALLOWED_ORIGINS` and adds the origins to the realm.

## Running

`bun run start:all` (also `bun run dev`) does the following:

1. Generates the dev certificate if missing. It builds the host and features if `dist` is missing, or always with
   `--build`.
2. Writes `apps/portal-config/default-modules.stack.yaml` (features origin, gitignored). The servers run on the
   committed `application.conf` / `application.trading.conf`; ports, CORS origins and Keycloak URL reach them as
   per-process env vars (`VUU_HTTPS_PORT`, `VUU_WEBSOCKET_PORT`, `VUU_CORS_ALLOWED_ORIGINS`, `VUU_KEYCLOAK_URL`,
   `VUU_PORTAL_DEFAULT_MODULES_FILE`, `VUU_PORTAL_MODULES_FILE`), derived from the `TRADER_*` settings
   (`scripts/stack/config.ts` `serverEnv`) and read by the confs' `key=${?VUU_*}` lines.
3. Checks that every port is free. A busy port is reported with the `TRADER_*` variable that moves it. It never
   takes over a port.
4. Starts Keycloak, unless one already answers at `TRADER_KEYCLOAK_URL` / `https://localhost:8180`:
   - It uses `KEYCLOAK_HOME`, or the newest `~/keycloak/keycloak-*`, in dev mode with state under `.run/keycloak`.
   - It then creates or updates the realm, roles and users.
   - Without a local install, run `docker compose up -d keycloak` first (see `docker-compose.yml`).
5. Starts the portal server (the stock `@heswell/vuu-portal/main`), the trading server (`start-trading.ts`), the
   features server and the host with prefixed logs, each via `scripts/stack/serve.ts portal|trading|features|host`.
6. Waits until every part answers and prints the URLs and users.
7. On Ctrl-C (or SIGTERM), stops everything it started: SIGTERM, then SIGKILL after 15 s.

| Flag | Effect |
| --- | --- |
| `--build` | rebuild the host and features first |
| `--reseed` | reset the portal's runtime module list (`modules.stack.yaml`) to the defaults. This also happens automatically when the defaults change. |
| `--prepare` | certs, builds and the generated module list only, then exit (for the `Procfile`) |

`Procfile` (overmind / foreman / honcho) runs the portal server, trading server, features and host as separate
processes with the same `scripts/stack/serve.ts` entries, so `TRADER_*` overrides apply too. Before using it, run
`bun run start:all --prepare` and start a Keycloak.

Outside `start:all`, the portal server is the stock bin: `bunx vuu-portal --config apps/portal-config/application.conf`
(or `VUU_CONFIG_FILE=...`); set `VUU_HTTPS_PORT` etc. to move it.

### Ports

Every port can be changed with an env var (`scripts/stack/config.ts`). The defaults avoid the ports a stock
vuu-websocket / finos vuu-ui checkout uses (5001, 5006, 8080, 8091, 8443).

The OMS generates background order flow for every account (`OMS_FLOW_ACCOUNTS`, see `packages/oms/README.md`).
The screenshots were taken with `OMS_FLOW_ACCOUNTS=ACC-US-02,ACC-EU-01,ACC-EU-02,ACC-ASIA-01,ACC-ASIA-02`, so
alice's account `ACC-US-01` only has her own orders.

| Variable | Default |
| --- | --- |
| `TRADER_HOSTNAME` | `localhost` |
| `TRADER_KEYCLOAK_PORT` / `_HTTP_PORT` / `_MGMT_PORT` | 8180 / 8181 / 9100 |
| `TRADER_KEYCLOAK_URL` | `https://$TRADER_HOSTNAME:$TRADER_KEYCLOAK_PORT` (set it to use an existing Keycloak) |
| `TRADER_PORTAL_WS_PORT` / `TRADER_PORTAL_HTTPS_PORT` | 8191 / 8543 |
| `TRADER_TRADING_WS_PORT` / `TRADER_TRADING_HTTPS_PORT` | 8192 / 8544 |
| `TRADER_TRADING_REST_URL` / `TRADER_TRADING_WEBSOCKET_URL` | derived from the two ports above (written to each remote's `config.json`) |
| `TRADER_TRADING_CLIENT_SECRET` | `trader-trading-local-dev-secret` (the `trader-trading-server` client secret; dev only) |
| `TRADER_HOST_PORT` | 5100 |
| `TRADER_FEATURES_PORT` / `TRADER_FEATURES_ORIGIN` | 5110 / `http://$TRADER_HOSTNAME:5110` |
| `TRADER_LOG_LEVEL` | unset = `info`. Passed to both Vuu servers as `VUU_LOG_LEVEL` (`trace`, `debug`, `info`, `warn`, `error` or `silent`) |

### Sessions per user

Each browser tab opens one Vuu session on the portal server and one on the trading server (the trading modules in a
tab share a ref-counted connection). Every trader conf sets

```
vuu.server.maxSessionsPerUser=5
vuu.server.sessionLimitPolicy="reject-new"
```

so a user can work in up to five tabs. A sixth login is refused: vuu-server closes its socket with code `4003`
(`maximum sessions (5) reached for user …`) and the existing tabs carry on. Closing or reloading a tab frees its
session at once, so a reload at the limit still works. The refused tab shows a blank page and does not retry when
a slot frees up (upstream issue 74); reload it once another tab is closed.

`evict-oldest` (close the oldest session with `4001`) would suit traders better, because a forgotten tab could not
block a new one. But vuu-ui ignores the close code and reconnects an evicted tab after a second, which then evicts
the next oldest, so with more tabs than the limit every tab is disconnected in turn, forever (upstream issue 73).
Switch to `evict-oldest` once that is fixed. Override the settings with `VUU_MAX_SESSIONS_PER_USER` /
`VUU_SESSION_LIMIT_POLICY` (set them in the shell before `start:all`; they apply to both servers).

## Users and roles

There are two sets of client roles, because the portal and the trading server are separate Keycloak clients:

- **Server roles** belong to the confidential client `trader-trading-server`: `trading-view`, `trading-execute`
  and `trading-supervisor`. They reach the trading server through token exchange, and the OMS checks them on
  every viewport and RPC (`oms.permissionMode="strict"`, `packages/oms/README.md`). Inside a feature,
  `useEntitlements()` reads them with `useVuuAuthorizations()`.
- **Nav roles** belong to the public `vuu-portal` client: `trading-access`, `trading-execute-access` and
  `trading-supervisor-access`. They are the modules' `accessRole`s, so the portal sends a user only the modules
  they may open. The realm bootstrap derives them from each user's server roles (`TRADING_ACCESS_ROLE` in
  `catalog.ts`), so the two sets always agree.

The `vuu-portal` client adds both `vuu-portal-server` and `trader-trading-server` to its tokens' audience, which
standard token exchange requires.

| User (password `password`) | Server roles (`trader-trading-server`) | Sees |
| --- | --- | --- |
| alice, bob, carol, erin | trading-view, trading-execute | All of Trading (Workspace with ticket and ladder; Ticket; Ladder) |
| dave | trading-view | Workspace, Watchlist, Depth, Orders, Fills, Positions, Tape. No Ticket or Ladder, and a read-only order blotter. |
| sam | trading-view, trading-supervisor | As dave, plus Supervision › Desk overview (all accounts) |
| admin | trading-view, trading-supervisor (plus `vuu-portal` module-admin-access, vuu-table-viewer-access) | Supervision, plus portal module admin |

The Keycloak admin console is at `https://localhost:8180/admin` (admin / admin). These are dev credentials only.
`bun run keycloak:realm export` rewrites `infra/keycloak/realm-vuu.json`, which docker-compose imports. Use
`bun run keycloak:realm bootstrap [--reset]` to apply the realm to a running Keycloak.

## Features

All features are built from one package, `apps/features/trading`, as **one MF remote per feature**. The portal
requires a unique `mfScope` per module (trader upstream issue 45). `src/catalog.ts` is the source of truth.
`bun run features:sync` generates `portal-build.json` and `apps/portal-config/default-modules.yaml` from it.
`bun run features:check` (run in CI) fails on drift and validates the yaml with the portal server's own loader.

The Role column is the server role. The module's `accessRole` is the matching nav role (`trading-view` →
`trading-access`, and so on).

| Nav | Module | Role | Content |
| --- | --- | --- | --- |
| Trading › Workspace | TradingWorkspace | trading-view | Prebuilt trader layout (below) |
| *(child)* | TradingWorkspaceTicket | trading-execute | Order ticket docked in the workspace |
| *(child)* | TradingWorkspaceLadder | trading-execute | Price ladder docked in the workspace |
| Trading › Watchlist | TradingWatchlist | trading-view | InstrumentGrid (sparklines, watchlists, Buy / Sell) |
| Trading › Depth | TradingDepth | trading-view | MarketDepth (own orders for the chosen account) |
| Trading › Ladder | TradingLadder | trading-execute | PriceLadder (click-to-trade) |
| Trading › Ticket | TradingTicket | trading-execute | OrderTicketPanel |
| Trading › Orders | TradingOrders | trading-view | OrderBlotter (read-only without trading-execute) |
| Trading › Fills | TradingFills | trading-view | FillsBlotter |
| Trading › Positions | TradingPositions | trading-view | PositionsView |
| Trading › Tape | TradingTape | trading-view | TradeTape |
| Supervision › Desk overview | TradingSupervisor | trading-supervisor | All visible accounts' orders and positions |

The workspace renders the ticket and ladder as **child modules** (`parentModuleId`, no nav entry), through
`usePortalModuleRegistry()` and `RemoteModule`. A user without trading-execute is not sent those modules, so the
workspace shows a placeholder in their place.

### Adding a feature

1. Add `src/features/<Name>.tsx`. Wrap the content with `withFeatureRoot` (see below) and give components stable
   `id`s, because they key saved state.
2. Add a catalog entry: unique `key`, `id`, `name`, `mfScope`; `location: "/Section/Label"` and `path` for a nav
   entry, or `parent` for a child module.
3. Run `bun run features:sync && bun run build`, then restart `start:all`. The module list is reseeded because the
   defaults changed.

### Per-host services: `TradingFeatureRoot`

Each feature wraps its content in `TradingFeatureRoot` (from `@heswell/trading-ui`). It mounts
`TradingNotificationsProvider` (with `InstrumentLookupProvider`), `OrderTicketLauncherProvider` and
`ConnectionBanner`:

- **Notifications are toasted once per window.** A window-global lease (`notificationLease`, kept on `globalThis`
  under a `Symbol.for` key) lets exactly one root stream order and fill notifications. When that feature closes,
  the lease passes to the oldest waiting root. With five features open, each fill is toasted once. The toast centre
  itself is the host's: PortalShell mounts the vuu NotificationsProvider.
- **Nested roots render children only.** The workspace's child modules render inside the parent's root, so Buy /
  Sell in the workspace grid targets the docked ticket.
- **The link bus is connected to `BroadcastChannel` once per window** (`ensureLinkBusBroadcast`, also called by the
  host). Popped-out features and other tabs stay linked.

Data access is `mode="inherit"`: features use the connection `RemoteModule` provides, which is the trading server
connection from `config.json` (see [Two Vuu servers](#two-vuu-servers)). `@vuu-ui/core` is a singleton.

### MF sharing

`scripts/features/sync-build-config.ts` writes the same `shared` block into the host and every remote:

| Shared singleton | Why |
| --- | --- |
| `react`, `react-dom`, `react-router-dom` | one React tree / router |
| `@vuu-ui/core`, `@vuu-ui/core/portal` | DataProvider, auth, module registry, persisted state |
| `@vuu-ui/vuu-data-remote`, `@vuu-ui/vuu-notifications`, `@salt-ds/core` | one connection manager, one toast centre, one Salt theme context |
| `@heswell/trading-ui` | one instrument link bus, launcher and notification lease per window |

There are two deviations from the P3.11 plan:

- **`@vuu-ui/vuu-layout` is not shared.** As a shared singleton it deadlocks startup: its shared chunk bundles
  vuu-data-react, which imports `@vuu-ui/vuu-layout` again, and the host page stays blank (trader upstream issue 43). Each
  remote has its own copy instead.
  - Consequence: `@heswell/trading-ui`, a singleton bound to the host's copy, does not see a remote's `View`s.
    Components therefore save their link group in the module's portal state (`trading.linkGroup.<id>`), not in View
    state (trader upstream issue 50).
- **The chunk-loading global is renamed per remote.** All remotes from one package get the same JSONP global, so
  loading two at once fails with `__webpack_modules__[moduleId] is not a function`. portal-build has no option for
  this, so `scripts/features/build.ts` renames it to `rspackChunk_<mfScope>` after each build (trader upstream issue 44).

`cssInline` includes `/packages/trading-ui/` for every package, and the feature package's own path for the
remotes. Do not include the host's own path: cssInline turns plain `.css` imports in included paths into strings,
so the host's CSS would not be applied (trader upstream issue 47).

## Layouts and saved state

The **trader workspace** is the prebuilt default layout. It contains the watchlist (red), Orders / Fills /
Positions tabs, the ticket (red, child module), depth (red), the ladder (green, child module) and the tape (green).
A green instrument picker sits in the toolbar, next to an account selector.

- Red follows the instrument grid, and green follows the picker. Every component has a link group selector.
- **Saved state** goes through the portal's `usePersistedState`. There is one state document per user and module,
  stored by PortalShell's default `LocalStoragePersistenceBackend`, so it is per browser. The vuu-portal server has
  no state persistence (trader upstream issue 49).
  - The workspace saves each View's state (`trader-workspace.views`) and each component's link group, and restores
    them on load.
  - A user's change of link group survives a reload; this was verified in a browser. **Reset layout** returns to
    the defaults.
- The arrangement (splitter sizes, moved views) is not saved. Restoring vuu-layout JSON needs the component
  registry, which is per bundle (trader upstream issue 53). The child modules (ticket, ladder) keep their own state, which Reset
  layout does not clear.
- The standalone features save their link groups the same way, keyed by component id.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Login loops or "Unable to authenticate" | Open `https://localhost:8180`, `https://localhost:8543`, `https://localhost:8191`, `https://localhost:8544` and `https://localhost:8192` once and accept the self-signed certificate (or trust `apps/portal-config/certs/cert.pem`). |
| A feature shows "Invalid remote module config" | Its `config.json` is missing or invalid. Rebuild with `bun run build`, or check `http://localhost:5110/<feature>/config.json`. |
| Features load but show no data | The trading server is down, or its certificate is not accepted (`https://localhost:8544`). Check the `trading` log prefix. Token exchange failures (401) mean the realm is missing the `trader-trading-server` client: run `bun run keycloak:realm bootstrap`. |
| `port N (...) is in use` | Another process has it. Set the `TRADER_*` variable shown. |
| `no Keycloak` | Set `KEYCLOAK_HOME`, unpack Keycloak 26.x into `~/keycloak/`, or `docker compose up -d keycloak`. |
| A new or renamed feature is missing from the nav | `bun run start:all --build --reseed`. The portal keeps its runtime module list in `modules.stack.yaml`. |
| Blank page after changing `shared` | Do not share `@vuu-ui/vuu-layout` (trader upstream issue 43). Check the browser console for MF `RUNTIME-` errors. |
| `__webpack_modules__[moduleId] is not a function` | A remote was built without the chunk-global rename. Use `bun run build`, not portal-build directly. |
| Feature has no styles | Its CSS path is missing from `cssInline.include` (run `bun run features:sync`). |
| Docker Keycloak cannot read the key | `key.pem` is mode 600. On Linux, `chmod 644 apps/portal-config/certs/key.pem` (dev cert only). |
| Toasts appear twice | Each feature must use `TradingFeatureRoot` (or `withFeatureRoot`), not its own `TradingNotificationsProvider`. |

## Verified

Verified with @vuu-ui 4.0.0-alpha.22, Keycloak 26.4.2 (real OIDC login and token exchange) and headless Chrome
against `bun run start:all`, with the trading modules on the standalone trading server. The scripts are not in the
repo. Screenshots are in [docs/screenshots](screenshots).

- **Token exchange:** each page load exchanges the `vuu-portal` token once at `https://localhost:8544/api/authn`
  (200). Every remote shares the one `trading` connection, and the OMS applies the exchanged token's roles in
  `strict` mode.
- **Order flow:** alice opens Trading › Ticket, buys 200 AAL.L at market, and gets "Filled 200 @ … O-…". The same
  order appears in Orders (Filled tab), Fills and Positions (`orders.png`, `fills.png`, `positions.png`,
  `ticket.png`).
- **Role gating:**
  - dave has no Ticket or Ladder in the nav. The workspace shows "needs trading-execute" placeholders, and his
    blotter has no amend, cancel or Cancel all (`workspace-dave-view-only.png`).
  - sam additionally gets Supervision › Desk overview and sees every account (`supervisor-sam.png`).
- **Linking across separately loaded remotes:**
  - In the workspace, picking BARC.L in the green picker drives the ladder (a child remote) and the tape.
  - Clicking a watchlist row drives depth and the ticket (a child remote) (`workspace-linked.png`).
  - Clicking a row in the standalone Watchlist feature, then opening the Ticket and Depth features from the nav,
    shows that instrument (`watchlist.png`, `depth.png`). Link state lives in the page, so a full reload clears it.
- **Saved state** (verified in Phase 4 on alpha.20, not re-run): switching the workspace's Depth to green survives a
  page reload, and Reset layout returns it to red.
- **Not verified:** `docker-compose.yml` (no Docker on the dev machine) and the `Procfile` under a process manager.
  `--prepare` was run.
