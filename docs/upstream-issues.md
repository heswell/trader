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

## Found in Phase 3 wave 1 (UI foundation)

20. **`@heswell/vuu-data-engine-local` has import-time side effects.** Importing it creates the SIMUL/TEST/BASKET
    demo modules and starts their timers, although the package declares `sideEffects: false`. Bundlers may
    tree-shake it unexpectedly. A Bun/Node script that imports it also never exits on its own, because the timers
    keep the process alive, so the script needs `process.exit`. *Workaround:* none needed in the browser; `bun test`
    exits normally. Creating the modules lazily upstream would fix both problems.
21. **engine-local's `tableContainer` is global and keyed by bare table name**, and `getTableList` and modules
    resolve tables through it. A second test-data instance (or another module with a `prices` table) replaces the
    first instance's tables. *Workaround:* `createTradingTestData` documents "one live instance at a time". Tests
    create one per test and `dispose()` it in `afterEach`. Keying by `{module, table}` upstream would allow
    several instances.
22. **engine-local's default edit-session RPC services cannot be overridden** per table, so saving a `parentOrders`
    session would write rows directly instead of going through the OMS. *Workaround:* `TradingLocalModule` has a
    `beforeSessionSave` hook. It turns quantity/price edits into `amendOrder` and deletes into `cancelOrder`, and
    clears `vuuAction` on the rows it handled so the default write skips them. An overridable session-save service
    upstream would be cleaner.
23. **`@vuu-ui/portal-build` `cssInline` covers only vuu packages by default, and `pluginCssInline` is not
    exported.** Components that inject CSS (`useComponentCssInjection` with `import css from "./X.css"`) need
    `"cssInline": {"include": ["/packages/trading-ui/", "/apps/features/"]}` in every feature's
    portal-build.json. Apps that don't use portal-build (the showcase) must reimplement the rewrite
    (`apps/showcase/css-inline-loader.cjs`). Exporting the plugin would let other rsbuild apps reuse it.
24. **`@heswell/hft-limit-order-book` imports `randomUUID` from `node:crypto`**, which breaks browser bundles of
    exchange-sim. In rspack a `resolve.alias` does not apply to `node:` URIs. *Workaround:*
    `@heswell/trading-test-data/shims/node-crypto` (it uses `globalThis.crypto.randomUUID`), mapped with
    `rspack.NormalModuleReplacementPlugin`. Using `globalThis.crypto` upstream (available in Node ≥ 19 and in
    browsers) would remove the need for the shim.
25. **The REST auth CORS config allows a single origin** (`vuu.auth.cors.allowedOrigin`), so dev apps on other
    ports cannot authenticate directly. *Workaround:* the showcase dev server proxies `/remote/trading/*` to the
    trading server, which makes the requests same-origin. Allowing a list of origins would help.
26. **engine-local `subscribe` requires a vuu-utils `Range` object** (`Range(0, 100)`), not a plain `{from, to}`
    (`range.reset` is called), unlike the remote `VuuDataSource`. This is minor; tests use `Range` from
    `@vuu-ui/vuu-utils`.
27. **Permissive auth rejects an empty password** (HTTP 401). It returns the token both in the body and in a
    `vuu-auth-token` header. Not a bug, but undocumented. `connectToVuuServer` requires a password and reads either
    form.
28. **`positions` / `positionPrices` have no sector (or any instrument static) column**, so PositionsView cannot group by
    sector; it groups by currency then account or ric. Adding `sector` to `instruments` and a join column to
    `positionPrices` would enable it. (This repo's schema, not vuu.)
29. **No cross-table tree / LinkedTableView in alpha.20**, and `Table.onSelectionChange` reports key-based requests
    (`SELECT_ROW`, `SELECT_ROW_RANGE`, ...) rather than the selected row set, so ranges can only be resolved with a
    second data source. OrderBlotter uses a child-orders detail panel and a mirror subscription
    (`useTableSelectedKeys`).
30. **No VWAP aggregation** (vuu aggregation types: sum, average, count, high, low, distinct). FillsBlotter sums
    `quantity` and `notional` and computes `notional / quantity` in a cell renderer.
31. **Editable Table cells need the edit-session snapshot data source as the Table's own source**, which loses live
    updates, so inline editing is impractical on a ticking blotter. `editOrdersInSession` drives the same server edit
    session (`beginEditSession` / `editCell` / `endEditSession`) programmatically; the OrderBlotter amend dialog uses
    `amendOrder` by default.
32. **Custom cell renderers are looked up by name in a global registry** and the package `sideEffects` only lists
    CSS, so each component module must call `registerTradingCellRenderers()` at import time.
33. **A `LEFT JOIN` row without a price shows `0` (not empty) for numeric columns** in `instrumentPrices`, so a client
    cannot tell "no price yet" from a price of 0. *Workaround:* the sparkline renderer ignores 0 samples
    (`ignoreZero`) and the grid defaults to `simulated = true`.
34. **vuu `TablePicker` cannot be used as a controlled instrument picker.** It has no controlled `value` (the
    selected text can't be set from a prefill or from the selected instrument), it logs to the console, and it does
    not unsubscribe the data source it creates. *Workaround:* `InstrumentPicker` is a Salt `ComboBox` over
    `useTradingRows("instruments", { filter })`.
35. **`@vuu-ui/vuu-notifications` `NotificationsProvider` uses one module-level context**, so nested providers
    shadow each other, and without a provider `showNotification` only logs "have you forgotten to provide a
    NotificationsCenter?". *Workaround:* `TradingNotificationsProvider` mounts it only with `notificationsCenter`,
    and accepts a `toastSink`.
36. **`ConnectionManager.connectionStatusFor(id)` creates the connection (and worker) if it does not exist**, so
    observing status can open a connection. *Workaround:* `useTradingConnectionStatus` only calls it in remote or
    inherit mode with a non-local data provider, and otherwise relies on `onConnectionStatus`. A read-only status
    getter would help.
