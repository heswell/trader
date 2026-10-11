# trader

Reusable trading front-end (instrument grids, market depth / price ladder, order ticket, order & trade blotters) built on [Vuu](https://github.com/finos/vuu) UI components and the `vuu-portal`, exercised by a simulated backend (exchange simulator + OMS) running on [vuu-websocket](https://github.com/heswell/vuu-websocket).

Status: Phase 1. The exchange simulator (`EXCHANGE` module: instruments, prices, depth, trades, instrumentPrices,
admin RPCs, in-process OMS gateway) is in place. The `tradingHello` remote shows `EXCHANGE/instrumentPrices`.

## Layout

```
packages/
  trading-schemas/    shared table defs, enums, RPC contracts, tick/lot utils
  exchange-sim/       exchange simulator: order books, bots, EXCHANGE module, OMS gateway (see its README)
  oms/                OMS module: orders, risk, routing, positions, background flow (see its README)
  trading-ui/         reusable React components, data hooks, instrument context, formatters (see docs/ui-guide.md)
  trading-test-data/  in-browser EXCHANGE + OMS (real engines on @heswell/vuu-data-engine-local)
apps/
  features/hello/     module-federation remote (rsbuild via @vuu-ui/portal-build), :5010; exchange prices grid
  showcase/           rsbuild dev app: trading-ui examples on local data or a server, :5001
  portal-config/      application.conf, default-modules.yaml and launcher for vuu-portal
docs/ui-guide.md      UI conventions (components, styling, data access, showcase, tests, MF features)
docs/upstream-issues.md
scripts/              link, certs, dev, typecheck helpers
```

## Prerequisites

- [bun](https://bun.sh) >= 1.3 (CI uses 1.3.14), openssl, Keycloak (realm `vuu`) for portal login.
- A checkout of [heswell/vuu-websocket](https://github.com/heswell/vuu-websocket) **alongside this repo**
  (`../vuu-websocket`) with dependencies installed. vuu-websocket uses `npm install` (its own convention).
- **trader must be installed with `bun install` only.** npm, yarn and pnpm are unsupported (workspace protocol);
  a `preinstall` guard fails fast with a clear message.

`@heswell/vuu-server`, `@heswell/service-utils` and `@heswell/vuu-portal` are not published, so
`bun install` runs `scripts/link-vuu-websocket.ts`, which symlinks them into `node_modules/@heswell/`
from `$VUU_WEBSOCKET_DIR` (env var or `.env`, default `../vuu-websocket`). Re-run with `bun run link:vuu`.
Published deps (`@vuu-ui/*@4.0.0-alpha.20`, `@vuu-ui/portal-build`) come from npm.

```sh
cp .env.example .env   # set VUU_WEBSOCKET_DIR if not ../vuu-websocket
bun install
```

## Run

```sh
bun run dev
```

Generates a self-signed cert, builds the hello remote if needed, then starts:

| What | Where |
| --- | --- |
| portal + EXCHANGE + OMS modules (one server) | `wss://localhost:8091/websocket-portal`, `https://localhost:8443/api/authn` |
| hello remote | `http://localhost:5010` |
| portal host UI (only if `VUU_PORTAL_HOST_DIR` set) | `http://localhost:5001` |

The portal host UI is not in vuu-websocket or published to npm; it is built in the
[finos/vuu](https://github.com/finos/vuu) repo (`vuu-ui/dist_portal/portal-host`). Point
`VUU_PORTAL_HOST_DIR` at that build (its `config.json` expects Keycloak `https://localhost:8080`,
REST `https://localhost:8443/api/authn`, ws `wss://localhost:8091/websocket-portal`), or use an
already-running host on :5001. Create Keycloak users with vuu-websocket's `npm run keycloak:bootstrap`
and log in as `trader1`/`trader2`/`admin`; the "Exchange prices" module then appears in the nav.

Other commands: `bun run build` (remotes), `bun run typecheck` (emits .d.ts for the linked vuu packages into `.vuu-types/`, then checks only trader code), `bun run lint`, `bun run format`,
`bun run test` (`test:server` + `test:ui`, the latter with a happy-dom preload). UI showcase: `bun run dev:showcase`
(http://localhost:5001, local data; its "Remote server" toggle uses `bun run dev:trading-server`). Stand-alone exchange-sim (permissive auth, TLS with the dev cert, `wss://localhost:8094/websocket-exchange-sim`): `bun run --filter @heswell/exchange-sim start`;
benchmark: `bun run --filter @heswell/exchange-sim bench`. Simulator knobs (`exchangeSim.*` / `EXCHANGE_SIM_*`)
are documented in [packages/exchange-sim/README.md](packages/exchange-sim/README.md).
Stand-alone EXCHANGE + OMS (permissive auth, `wss://localhost:8095/websocket-trading`): `bun run --filter @heswell/oms start`.
OMS knobs (`oms.*` / `OMS_*`), RPCs, roles (`trading-view` / `trading-execute` / `trading-supervisor`) and
seeded accounts (owners alice, bob, carol, dave, erin) are in [packages/oms/README.md](packages/oms/README.md).
Keycloak users without trading roles who own no account (e.g. `trader1`) see all accounts while
`oms.permissionMode="auto"`.

### Verified / not verified

Verified (Phase 2): OMS tests (68, including WebSocket tests against a real VuuServer with EXCHANGE + OMS). Also
`start-portal.ts`, using an alternate-port permissive copy of the config: REST login as `alice`, then `CREATE_VP` on
`OMS/parentOrders` streams background-flow orders (NEW/FILLED/CANCELLED) filtered to `ACC-US-01`. The stand-alone
OMS server starts on :8095. Keycloak roles are not verified (the realm has no trading roles yet, upstream #15).


Verified (Phase 1): tests (including a VuuServer + websocket integration test); remote build. The composite
portal server (`start-portal.ts`, which is what `bun run dev` runs), using an alternate-port copy of the config
with permissive auth: login works, and `CREATE_VP` on `EXCHANGE/prices`, `depth`, `trades` and `instrumentPrices`
streams ticking updates. A `haltInstrument` RPC returns `SUCCESS_RESULT`. The same was checked on the
stand-alone server. Not verified in a browser: the full Keycloak login and host UI, because ports
5001/8091/8443 were occupied by other local services during development.

## CI

`.github/workflows/ci.yml` checks out vuu-websocket alongside, installs, then typechecks, lints,
format-checks and tests. If vuu-websocket is private, add a `VUU_WEBSOCKET_TOKEN` secret (read access).

## Upstream

See [docs/upstream-issues.md](docs/upstream-issues.md).
