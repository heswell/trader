# Operations runbook

How to run, configure, reset, measure and troubleshoot the trader stack. This page gives the essentials and links to
the detailed docs instead of repeating them. For how the parts fit together, see [architecture.md](architecture.md).

## Prerequisites

- [bun](https://bun.sh) 1.3 or later (CI uses 1.3.14) and openssl. **Install with `bun install` only**: a
  `preinstall` guard rejects npm, yarn and pnpm.
- Keycloak 26.x, for the full stack. `start:all` finds it in one of these ways:
  - `KEYCLOAK_HOME`;
  - the newest `~/keycloak/keycloak-*`;
  - an already-running Keycloak at `TRADER_KEYCLOAK_URL`;
  - `docker compose up -d keycloak`.
- Playwright's Chromium (`bunx playwright install chromium`), only for the opt-in e2e and UI perf scripts.

## Start and stop

```sh
bun install
bun run start:all            # alias: bun run dev
```

1. Open http://localhost:5100 and log in as `alice` / `password`.
2. The first time, open each HTTPS endpoint once and accept the self-signed certificate:
   - https://localhost:8180
   - https://localhost:8543
   - https://localhost:8191
   - https://localhost:8544
   - https://localhost:8192
3. Ctrl-C (or SIGTERM) stops everything `start:all` started.

`start:all` checks that the ports are free, starts Keycloak and creates the realm if needed, then starts the
portal server, trading server, features server and host. It never takes over a busy port. See
[portal-integration: running](portal-integration.md#running) for the full sequence.

| Flag | Effect |
| --- | --- |
| `--build` | Rebuild the host and features first (the default builds only if `dist` is missing). |
| `--reseed` | Reset the portal's runtime module list (`modules.stack.yaml`) to the defaults. |
| `--prepare` | Certs, builds and the generated module list only, then exit (for the `Procfile`). |
| `--keycloak-only` | Start Keycloak and apply the realm only. |
| `--restart-trading` | Respawn the trading server when it exits on a signal (pid in `.run/trading.pid`); see [persistence.md](persistence.md#verified). |

Lighter set-ups, with no Keycloak:

| Command | What | Where |
| --- | --- | --- |
| `bun run dev:showcase` | Component showcase on in-browser data | http://localhost:5001 |
| `bun run dev:trading-server` | Stand-alone EXCHANGE + OMS, permissive auth over plain HTTP | `ws://localhost:8095/websocket-trading`, `http://localhost:8447/api/authn` |
| `bun run --filter @heswell/exchange-sim start` | Stand-alone exchange-sim | `ws://localhost:8094/websocket-exchange-sim` |

The `Procfile` (overmind, foreman, honcho) runs the same processes. Run `bun run start:all --prepare` first, and
start Keycloak yourself.

## Ports and URLs

| Part | Default | Env var |
| --- | --- | --- |
| portal host | http://localhost:5100 | `TRADER_HOST_PORT` |
| trading features (MF remotes) | http://localhost:5110/&lt;feature&gt;/ | `TRADER_FEATURES_PORT`, `TRADER_FEATURES_ORIGIN` |
| portal Vuu server | `wss://localhost:8191/websocket-portal`, https 8543 | `TRADER_PORTAL_WS_PORT`, `TRADER_PORTAL_HTTPS_PORT` |
| trading Vuu server | `wss://localhost:8192/websocket-trading`, https 8544 | `TRADER_TRADING_WS_PORT`, `TRADER_TRADING_HTTPS_PORT` |
| Keycloak (admin / admin) | https 8180, http 8181, management 9100 | `TRADER_KEYCLOAK_PORT`, `_HTTP_PORT`, `_MGMT_PORT`, `TRADER_KEYCLOAK_URL` |
| showcase | http://localhost:5001 | `server.port` in `apps/showcase/rsbuild.config.ts` |
| stand-alone OMS / exchange-sim | 8095 + 8447 / 8094 | their `application.conf` |

The defaults avoid the ports of a stock vuu-websocket or finos vuu-ui checkout. All `TRADER_*` variables, including
`TRADER_HOSTNAME`, `TRADER_TRADING_REST_URL`, `TRADER_TRADING_WEBSOCKET_URL`, `TRADER_TRADING_CLIENT_SECRET` and
`TRADER_LOG_LEVEL`, are listed in [portal-integration: ports](portal-integration.md#ports). They are defined in
`scripts/stack/config.ts`.

## Configuration

Configuration is layered. A HOCON `application.conf` key can be overridden by an env var, and the env var wins.

| Area | Conf keys | Env vars | Reference |
| --- | --- | --- | --- |
| Vuu servers (ports, CORS, Keycloak, logs, sessions) | `vuu.*` in `apps/portal-config/application.conf` and `application.trading.conf` | `VUU_HTTPS_PORT`, `VUU_WEBSOCKET_PORT`, `VUU_CORS_ALLOWED_ORIGINS`, `VUU_KEYCLOAK_URL`, `VUU_LOG_LEVEL`, `VUU_MAX_SESSIONS_PER_USER`, `VUU_SESSION_LIMIT_POLICY`, ... (`start:all` derives these from `TRADER_*`) | [portal-integration: running](portal-integration.md#running), [sessions per user](portal-integration.md#sessions-per-user) |
| Exchange simulator (instruments, bots, publish rate, session) | `exchangeSim.*` | `EXCHANGE_SIM_*` | [exchange-sim: configuration](../packages/exchange-sim/README.md#configuration) |
| OMS (risk limits, background flow, marks) | `oms.*` | `OMS_*`, e.g. `OMS_FLOW_ACCOUNTS` | [OMS: config](../packages/oms/README.md#config) |
| Persistence | `persistence.store`, `dir`, `fsync`, `snapshotIntervalMs`, `snapshotEveryEntries`, `reset`, `cancelOrphans` | `PERSISTENCE_*` / `TRADER_PERSISTENCE_*`, `TRADER_DATA_DIR` | [persistence: configuration](persistence.md#configuration) |
| Client resilience (reconnect, timeouts, stale) | code options | none | [resilience: configuration](resilience.md#5-configuration) |
| Showcase remote target | none | `TRADING_REMOTE_WS`, `TRADING_REMOTE_AUTH` (at build time); URL `?ws=`, `?auth=`, `?data=remote` | [showcase README](../apps/showcase/README.md) |

## Users and roles

All users have the password `password`. Keycloak's own admin is `admin` / `admin` at https://localhost:8180.

| User | Can |
| --- | --- |
| alice, bob, carol, erin | view and trade (ticket, ladder, amend / cancel) |
| dave | view only (no Price ladder, read-only blotters) |
| sam | view, plus Oversight › Desk overview |
| admin | supervision and portal module admin |

- **Realm.** `bun run keycloak:realm export|bootstrap` writes `infra/keycloak/realm-vuu.json`, or applies it to a
  running Keycloak.
- **Roles and accounts.** For the role mapping (navigation roles vs trading roles) and how seeded accounts map to
  owners, see [portal-integration: users and roles](portal-integration.md#users-and-roles) and
  [OMS: permissions](../packages/oms/README.md#permissions).

## Persistence and reset

`start:all` keeps the trading server's books, orders, fills, positions and ids in `.data/trading`, which is
gitignored.

| To | Do |
| --- | --- |
| Start fresh, with the server stopped | `bun run persistence:reset [dir]`. It refuses while a live server holds the lock. |
| Start fresh at the next start | `TRADER_PERSISTENCE_RESET=1 bun run start:all` |
| Turn persistence off | `TRADER_PERSISTENCE_STORE=memory bun run start:all` |
| Use sqlite or another directory | `TRADER_PERSISTENCE_STORE=sqlite`, `TRADER_DATA_DIR=/path` |
| Reset the portal's module list (not order state) | `bun run start:all --reseed` |

See [persistence.md](persistence.md) for the guarantees and recovery.

## Checks, tests, perf and e2e

| Script | What | In CI |
| --- | --- | --- |
| `bun run typecheck` / `lint` / `format:check` (`format` writes) | tsc and Biome | yes |
| `bun run test:server` | schemas, persistence, exchange-sim, OMS and trading-test-data tests (no DOM) | yes (`test`) |
| `bun run test:ui` | trading-ui tests with happy-dom | yes (`test`) |
| `bun run features:check` (`features:sync` writes) | Generated `portal-build.json` / `default-modules.yaml` match `catalog.ts` | yes |
| `bun run build` | Portal host and features | yes |
| `bun run docs:check` (`docs:api` writes) | Generated API reference is up to date, and relative links and anchors resolve | yes |
| `bun run perf:ws [--preset=smoke\|heavy] [--target=local\|stack] [--assert]` | WS throughput, N clients × M viewports | smoke preset with `--assert` |
| `bun run perf:ui` / `bun run perf:ladder` | UI tick-rate profile and ladder frame budget in headless Chrome | no |
| `bun run e2e:resilience` | Kills and restarts servers under a logged-in browser | no |
| `bun run e2e:persistence` | `kill -9` of the trading server, then checks the UI shows the same state | no |
| `bun run --filter @heswell/exchange-sim bench` | Matching-engine benchmark | no |

The e2e scripts use their own ports: they shift them by `E2E_PORT_OFFSET` when the defaults are busy, and stop
only what they started. Flags and baselines:

- [performance.md](performance.md)
- [resilience: testing](resilience.md#6-testing)
- [persistence: tests](persistence.md#tests)

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Login loops, or "Unable to authenticate" | Accept the self-signed certificate on each HTTPS port (see [Start and stop](#start-and-stop)), or trust `apps/portal-config/certs/cert.pem`. |
| `port N (...) is in use` | Set the `TRADER_*` variable that the message names. |
| `no Keycloak` | Set `KEYCLOAK_HOME`, unpack Keycloak 26.x into `~/keycloak/`, or `docker compose up -d keycloak`. |
| Features load but show no data, or 401s | The trading server is down or its certificate is not accepted. Check the `trading` log prefix, and run `bun run keycloak:realm bootstrap` if token exchange fails. |
| A new feature is missing from the nav | `bun run start:all --build --reseed` |
| A 6th tab stays blank | The per-user session limit (5, `reject-new`). Close a tab and reload; see [sessions per user](portal-integration.md#sessions-per-user). |
| Orders from a previous run reappear | Expected: state persists. Reset it (see [Persistence and reset](#persistence-and-reset)). |
| `persistence:reset` refuses | A live trading server holds the store's `LOCK`. Stop it first. |
| Showcase "Remote server" fails | Start `bun run dev:trading-server`, and serve the showcase from `localhost:5001` or `127.0.0.1:5001` (the CORS origins). |
| Components unstyled in your own app | The `.css` imports must load as strings; see [getting-started: set up the app](getting-started.md#0-set-up-the-app). |

For more, see [portal-integration: troubleshooting](portal-integration.md#troubleshooting) (MF build, shared
modules, Docker Keycloak, duplicate toasts) and [resilience: behaviour per failure](resilience.md#4-behaviour-per-failure).
