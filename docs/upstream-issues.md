# Upstream changes needed (vuu-websocket / vuu)

vuu-websocket was not modified. Workarounds are noted.

1. **Module registry cannot point a remote at a different Vuu server.** The UI descriptor supports a
   per-module `vuu: {connectionId, restUrl, websocketUrl}`, but `ModuleRecord` (vuu-server `LoginSuccess.ts`)
   and vuu-portal `ModuleRegistry` do not emit it, and `ModuleStore` drops `vuuConnectionId/vuuWebsocketUrl/vuuRestUrl`
   (`retiredModuleKeys`). *Workaround:* `apps/portal-config/src/start-portal.ts` hosts the trading modules
   inside the portal server. Needed before exchange-sim can run as its own process.
2. **`@heswell/vuu-server`, `service-utils`, `vuu-portal` are unpublished**; `main` points at `dist/`. Linked via symlink
   (see README). Also `import { createModuleRegistry } from "@heswell/vuu-portal"` was undefined at runtime through the
   link, so we deep-import `src/ModuleRegistry`.
3. **vuu-portal exports** do not include `loadModuleState`/`loadModuleAdminRole`; deep import used.
4. **`PortalMain` hard-codes its modules**; no hook to add modules. Composite launcher duplicates its ~20 lines.
5. **Portal host UI is not published** (only `@vuu-ui/portal-build` is). It must be built from finos/vuu.
6. **vuu-server / service-utils / vuu-portal do not typecheck** (`types` points at raw `src/*.ts`, which has errors such as
   missing `RpcNamedParams`, `ProxySessionDataTable`; vuu-websocket CI only runs `bun test`). *Workaround:* `scripts/vuu-types.ts`
   emits declarations with `tsc --noCheck` into gitignored `.vuu-types/`, and `tsconfig.typecheck.json` maps the packages to them.
   Ideally fix the errors and ship a real `dist/` with `.d.ts`.
7. **No trading roles in Keycloak bootstrap**; module uses `vuu-table-viewer-access`. Add e.g. `trading-access`.
8. **Config paths must be relative** (`getPath` rejects absolute), which makes ad-hoc configs outside the config
   directory awkward.

## Found in Phase 1 (exchange simulator)

9. **`ModuleFactory.addJoinTable` has no `ServiceFactory` parameter**, so a join table cannot have an RPC
   handler (or custom `ViewPortDef`). *Workaround:* `ExchangeModule` sets
   `module.viewPortDefs.set("instrumentPrices", serviceFactory)` after `asModule()`. This relies on
   `VuuServer.registerModule` reading the same Map after creating the tables.
10. **The `ServiceFactory` is invoked on every `CREATE_VP` and every `GET_TABLE_META`**
    (`ViewportContainer.getViewPortDefinition`). That means a new `RpcHandler` per call; `DefaultRpcHandler`
    also re-registers typeahead each time. *Workaround:* cache the handler per table container
    (`WeakMap`). A per-table singleton (or a documented contract) upstream would be cleaner.
11. **Menu RPCs are not supported server-side** (already noted in `docs/protocol-parity.md`). Admin actions
    are plain `RPC_REQUEST`s in a `VIEWPORT_CONTEXT`, so the UI needs a custom affordance rather than a context menu.
12. **Noisy `console.log`** in `ModuleFactory` (it dumps the whole module including `viewPortDefs`), `TableContainer`,
    `ViewportContainer` and `CoreServerApi` on every create, plus the `[SESSION] ... has not responded` warnings. This
    drowns test and bench output. A log level (or `debug`) would help.
13. **`@heswell/hft-limit-order-book` `modify`** (fork of nodejs-order-book): `modify(id, {price?, size?})` re-inserts
    the order, so it **loses time priority even when only reducing size**, which differs from real exchanges. It also
    resets `timeInForce`/`stpMode` to defaults. Trade ids from `onTrade` are per book, so the simulator issues its own
    global `TR<n>` ids. *Workaround:* the gateway documents "amend loses priority". Only resting DAY/GTC orders can be
    amended, so the TIF reset doesn't matter yet. Bots only use cancel/new.
14. **The REST auth server now requires TLS** (`RestServer`: "REST HTTPS server requires SSL"), so the Phase 0
    stand-alone config (`vuu.ssl=false`) no longer started. *Fix:* the stand-alone exchange-sim uses the shared
    self-signed dev cert. Allowing plain HTTP for local/permissive setups would simplify tests.

## Found in Phase 2 (OMS)

15. **No trading roles in the Keycloak realm.** `packages/oms` recognises `vuu-portal` client roles
    `trading-view`, `trading-execute` and `trading-supervisor` (see packages/oms/README.md "Permissions"). The vuu realm
    bootstrap should create them and assign them to test users. For example: alice/bob/carol/dave/erin get
    `trading-view` and `trading-execute`, and a supervisor user gets `trading-supervisor` (this supersedes #7's
    `trading-access`). Until then the OMS runs with `oms.permissionMode="auto"`: account owners see their own
    accounts, and users without roles who own no accounts see everything.
16. **`JoinTableDef` constructor drops `permissionFunction`.** The base `TableDef` accepts one, but the join def does
    not pass it through. *Workaround:* `OmsModule` wraps the `positionPrices` join factory and sets
    `permissionFunction` on the created def. `ModuleFactory.addJoinTable` still has no `ServiceFactory` (#9), so the
    same `viewPortDefs.set(...)` workaround is used for the join's RPC handler.
17. **`editCell` (CreateSessionTableRpcHandler) edits the source table when the viewport is not an edit session.**
    Any client with an RPC-capable viewport can then overwrite rows directly. *Workaround:* `OmsRpcHandler` guards all
    edit-session RPCs. They are only allowed on a `parentOrders` session table, only `quantity`/`price` may be edited,
    and `addRow` is refused.
18. **The base `handleEndEditSession` ignores the result of `applySessionSave`.** It always reports success and drops
    the session, so a subclass cannot report per-row failures. *Workaround:* `OmsRpcHandler` overrides
    `handleEndEditSession` (it uses `prepareSessionSave` for the stale-row check). A save that returns a result would
    let OMS-style handlers just override `applySessionSave`.
19. **exchange-sim has no trading session / close.** Phases only change through halt/resume, so DAY orders never
    expire on their own. *Workaround:* `OmsEngine.endOfDay()` expires working DAY orders on demand. A scheduled
    close (and `MARKET_CLOSED` reject window) in exchange-sim would make this automatic. This is our own package, so
    it's for a later phase rather than upstream.
