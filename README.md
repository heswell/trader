# trader

Reusable trading front-end (instrument grids, market depth / price ladder, order ticket, order & trade blotters) built on [Vuu](https://github.com/finos/vuu) UI components and the `vuu-portal`, exercised by a simulated backend (exchange simulator + OMS) running on [vuu-websocket](https://github.com/heswell/vuu-websocket).

Status: Phase 6 (workspaces). The trading UI runs in vuu-portal as role-gated module-federation features under a
`PortalNav` (Workspaces: Trader, plus the user's own; Trading: Watchlist, Orders, Executions, Price ladder;
Market: Market depth, Time & sales, Chart, Depth chart; Portfolio: Positions, P&L, Exposure, Execution quality; Oversight: Desk overview). The
features connect to a standalone trading Vuu server (exchange simulator + OMS), separate from the portal's own Vuu
server, through @vuu-ui's per-module `config.json`. One command starts the whole stack. See
[docs/portal-integration.md](docs/portal-integration.md).

![Trader workspace](docs/screenshots/workspace-linked.png)

## Quick start

```sh
bun install
bun run start:all        # or: bun run dev
```

Open http://localhost:5100 and log in as `alice` / `password`. The first time, open https://localhost:8180,
https://localhost:8543, https://localhost:8191, https://localhost:8544 and https://localhost:8192 and accept the
self-signed dev certificate. `start:all` needs
Keycloak 26.x: `KEYCLOAK_HOME`, a `~/keycloak/keycloak-*` install, an already-running Keycloak
(`TRADER_KEYCLOAK_URL`), or `docker compose up -d keycloak`. It creates the realm, clients, roles and users itself.
The trading roles belong to the trading server's own Keycloak client (`trader-trading-server`), which receives the
portal user's token by token exchange.

| User (password `password`) | Can |
| --- | --- |
| alice, bob, carol, erin | view and trade (ticket, ladder, amend / cancel) |
| dave | view only |
| sam | view, plus Oversight › Desk overview |
| admin | supervision and portal module admin |

| What | Where |
| --- | --- |
| portal host (PortalShell) | http://localhost:5100 |
| trading features (MF remotes) | http://localhost:5110/&lt;feature&gt;/ |
| portal Vuu server (module registry) | `wss://localhost:8191/websocket-portal`, `https://localhost:8543` |
| trading Vuu server (EXCHANGE + OMS) | `wss://localhost:8192/websocket-trading`, `https://localhost:8544` |
| Keycloak (admin / admin) | https://localhost:8180 |

All ports can be changed with `TRADER_*` env vars, and busy ports are reported, not taken over. Flags: `--build`
(rebuild the features), `--reseed` (reset the portal module list) and `--prepare` (build and generate config only,
for the `Procfile`) and `--restart-trading` (restart the trading server when it exits on a signal; its pid is in
`.run/trading.pid`). Ctrl-C stops everything. See
[docs/portal-integration.md](docs/portal-integration.md#running) for details and troubleshooting.

## Documentation

Start with [docs/README.md](docs/README.md), the index of all docs.

| I want to | Read |
| --- | --- |
| Understand the system | [Architecture](docs/architecture.md): processes and ports, data, order, auth and persistence flows, package map, design decisions |
| Use the components in my own app | [Getting started](docs/getting-started.md) (remote vuu-server or engine-local), then the [component guides](docs/components/README.md) and the generated [API reference](docs/api/README.md) |
| See every component running | The [showcase](apps/showcase/README.md): `bun run dev:showcase`, http://localhost:5001, no servers needed |
| Write or change a component | [UI guide](docs/ui-guide.md) |
| Run, configure, reset or debug the stack | The [operations runbook](docs/operations.md) |
| Know about dependency problems | [Upstream issues](docs/upstream-issues.md) |

## Layout

```
packages/
  trading-schemas/    shared table defs, enums, RPC contracts, tick/lot utils
  persistence/        journal + snapshot stores (memory, file, sqlite) for the trading server
  exchange-sim/       exchange simulator: order books, bots, EXCHANGE module, OMS gateway (see its README)
  oms/                OMS module: orders, risk, routing, positions, background flow (see its README)
  trading-ui/         reusable React components, data hooks, instrument linking, TradingFeatureRoot (docs/components/)
  trading-test-data/  in-browser EXCHANGE + OMS (real engines on @heswell/vuu-data-engine-local)
  perf/               perf tools: WS load harness, UI tick-rate profiler, ladder frame budget (docs/performance.md)
apps/
  features/trading/   the portal features: catalog.ts -> one MF remote per feature (served on :5110)
  portal-host/        the portal host: PortalShell, Keycloak login, nav (:5100)
  portal-config/      portal + trading server configs and launchers, default-modules.yaml (generated)
  showcase/           rsbuild dev app: trading-ui examples on local data or a server, :5001
infra/keycloak/       realm export (roles, clients, seeded users) for docker-compose
docs/                 architecture, getting-started, operations, components/ (guides), api/ (generated), ...
scripts/              start-all, stack/ (config, Keycloak realm, static server), features/ (sync, build), e2e/, docs/, certs
```

## Prerequisites

- [bun](https://bun.sh) >= 1.3 (CI uses 1.3.14), openssl, Keycloak 26.x (realm `vuu`) for portal login.
- **trader must be installed with `bun install` only.** npm, yarn and pnpm are unsupported (workspace protocol);
  a `preinstall` guard fails fast with a clear message.

All dependencies come from npm:

- **Server side**, from [heswell/vuu-websocket](https://github.com/heswell/vuu-websocket):
  `@heswell/vuu-server@^4.2.2` and `@heswell/vuu-portal@^2.2.3`, which bring `@heswell/service-utils`,
  `@heswell/vuu-table`, `@heswell/vuu-viewport` and `@heswell/module-admin`.
- **UI**: `@vuu-ui/*@4.0.0-alpha.25` (including `@vuu-ui/vuu-chart`, on echarts) and `@vuu-ui/portal-build`.
- **Matching** uses `@heswell/hft-limit-order-book`, and engine-local mode uses `@heswell/vuu-data-engine-local`.

The @heswell packages only peer `@vuu-ui/*`. Every workspace that uses vuu-server therefore lists the `@vuu-ui`
packages it needs at alpha.25, and the install has one copy of each. No `overrides` are needed.

## Common commands

| Command | |
| --- | --- |
| `bun run start:all` | The whole stack ([operations](docs/operations.md#start-and-stop)) |
| `bun run dev:showcase` | Component showcase on in-browser data |
| `bun run typecheck`, `lint`, `format:check`, `test` | The checks CI runs, with `features:check`, `build`, `docs:check` and `perf:ws --preset=smoke --assert` |
| `bun run docs:api` | Regenerate the [API reference](docs/api/README.md) after changing an export |
| `bun run persistence:reset` | Clear the trading server's persisted order state |

All scripts, the e2e and perf tools, and troubleshooting are in the
[operations runbook](docs/operations.md#checks-tests-perf-and-e2e).

## Verified

Each phase was verified end to end. The details are kept with the docs:

- the portal stack with real Keycloak login and token exchange, driven by headless Chrome
  ([portal-integration](docs/portal-integration.md#verified));
- reconnect and resubscribe under server kills ([resilience](docs/resilience.md#6-testing));
- crash recovery with `kill -9` ([persistence](docs/persistence.md#verified));
- throughput and frame budgets ([performance](docs/performance.md#baselines)).

Not verified: `docker-compose.yml` (no Docker) and the `Procfile` under a process manager.

## CI

`.github/workflows/ci.yml` runs these steps:

1. install;
2. typecheck, lint, format-check and the tests;
3. `features:check` on the generated feature config;
4. `docs:check`: the generated API reference is current, and relative links and anchors resolve;
5. build the host and features;
6. the `perf:ws` smoke preset (5 clients × 5 viewports, `--assert`).
