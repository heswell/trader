# trader documentation

## Start here

| Doc | For |
| --- | --- |
| [architecture.md](architecture.md) | System overview: processes and ports, market data, order, auth and persistence flows, engine-local mode, package map, design decisions |
| [getting-started.md](getting-started.md) | Build your own trading app with the components (remote vuu-server, engine-local, or as a portal feature) |
| [operations.md](operations.md) | Runbook: start / stop, ports, env vars and config keys, users and roles, persistence reset, tests, perf, e2e, troubleshooting |

## Reusable front-end (`@heswell/trading-ui`)

| Doc | For |
| --- | --- |
| [components/](components/README.md) | Hand-written component guides: what each component is for, data it subscribes to, RPCs, roles, CSS hooks, examples |
| [api/](api/README.md) | **Generated** API reference: every export of trading-ui, trading-schemas and trading-test-data, with props, types, defaults and showcase links (`bun run docs:api`) |
| [ui-guide.md](ui-guide.md) | Conventions for writing components: folders, CSS injection and theming, data access, linking, tests, MF packaging |
| [Showcase](../apps/showcase/README.md) | A runnable example of every reusable component on in-browser data (`bun run dev:showcase`) |

## Server and stack

| Doc | For |
| --- | --- |
| [portal-integration.md](portal-integration.md) | vuu-portal host, MF features, the two Vuu servers, Keycloak, users and roles, `start:all` |
| [schemas.md](schemas.md) | Table and RPC schemas shared by server and UI (with [trading-schemas](../packages/trading-schemas/README.md)) |
| [exchange-sim](../packages/exchange-sim/README.md) | Exchange simulator: market model, trading session, bots, config, admin RPCs |
| [oms](../packages/oms/README.md) | OMS: orders, risk, state machine, positions, permissions, RPCs, edit session |
| [trading-test-data](../packages/trading-test-data/README.md) | The real engines in the browser (engine-local) |
| [persistence.md](persistence.md) | Journal + snapshots, stores, recovery, reset |
| [resilience.md](resilience.md) | Reconnect, resubscribe, stale data, RPC timeouts |
| [performance.md](performance.md) | `perf:ws`, `perf:ui`, `perf:ladder`, baselines |
| [protocol-parity.md](protocol-parity.md) | Vuu protocol coverage and the order-entry design choice |
| [upstream-issues.md](upstream-issues.md) | Problems in dependencies ("trader upstream issue N") |

## Keeping docs accurate

- **Generated reference.** `docs/api/*.md` is generated from the TypeScript sources and their JSDoc by
  `scripts/docs/api-reference.ts`. Run `bun run docs:api` after changing an export.
- **CI.** `bun run docs:check` runs in CI. It fails when:
  - the generated reference is out of date;
  - an export of those packages has no JSDoc;
  - a reusable component has no showcase example or guide (`apps/showcase/src/examples/docs.ts`);
  - a relative link or `#anchor` in the docs or READMEs is broken (`scripts/docs/check-links.ts`).
- **Guides.** The guides in [components/](components/README.md) are hand-written. Each one links to the reference
  and to the showcase ids of its component.
