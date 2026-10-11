# trader

Reusable trading front-end (instrument grids, market depth / price ladder, order ticket, order & trade blotters) built on [Vuu](https://github.com/finos/vuu) UI components and the `vuu-portal`, exercised by a simulated backend (exchange simulator + OMS) running on [vuu-websocket](https://github.com/heswell/vuu-websocket).

Status: bootstrap. Only a hello-world (`helloPrices` table + `tradingHello` remote) exists.

## Layout

```
packages/
  trading-schemas/    shared types (placeholder)
  exchange-sim/       Vuu server modules; HELLO module with ticking helloPrices table
  oms/                order management (placeholder)
  trading-ui/         shared React components (placeholder)
  trading-test-data/  test data (placeholder)
apps/
  features/hello/     module-federation remote (rsbuild via @vuu-ui/portal-build), :5010
  showcase/           placeholder
  portal-config/      application.conf, default-modules.yaml and launcher for vuu-portal
docs/upstream-issues.md
scripts/              link, certs, dev, typecheck helpers
```

## Prerequisites

- [bun](https://bun.sh) >= 1.3, openssl, Keycloak (realm `vuu`) for portal login.
- A checkout of [heswell/vuu-websocket](https://github.com/heswell/vuu-websocket) **alongside this repo**
  (`../vuu-websocket`) with dependencies installed (`npm install` there).

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
| portal + exchange-sim modules (one server) | `wss://localhost:8091/websocket-portal`, `https://localhost:8443/api/authn` |
| hello remote | `http://localhost:5010` |
| portal host UI (only if `VUU_PORTAL_HOST_DIR` set) | `http://localhost:5001` |

The portal host UI is not in vuu-websocket or published to npm; it is built in the
[finos/vuu](https://github.com/finos/vuu) repo (`vuu-ui/dist_portal/portal-host`). Point
`VUU_PORTAL_HOST_DIR` at that build (its `config.json` expects Keycloak `https://localhost:8080`,
REST `https://localhost:8443/api/authn`, ws `wss://localhost:8091/websocket-portal`), or use an
already-running host on :5001. Create Keycloak users with vuu-websocket's `npm run keycloak:bootstrap`
and log in as `trader1`/`trader2`/`admin`; the "Trading / Hello" module then appears in the nav.

Other commands: `bun run build` (remotes), `bun run typecheck` (emits .d.ts for the linked vuu packages into `.vuu-types/`, then checks only trader code), `bun run lint`, `bun run format`,
`bun test`. Stand-alone exchange-sim (permissive auth, port 8094): `bun run --filter @heswell/exchange-sim start`.

### Verified / not verified

Verified: tests; remote build; the portal server boots with portal + HELLO modules, login works and a
`CREATE_VP` on `HELLO/helloPrices` streams ticking updates over the websocket (permissive auth on
alternate ports). Not verified in a browser: the full Keycloak login + host UI, since ports 5001/8091/8443
were occupied by other local services during development.

## CI

`.github/workflows/ci.yml` checks out vuu-websocket alongside, installs, then typechecks, lints,
format-checks and tests. If vuu-websocket is private, add a `VUU_WEBSOCKET_TOKEN` secret (read access).

## Upstream

See [docs/upstream-issues.md](docs/upstream-issues.md).
