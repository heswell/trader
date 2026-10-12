# Upstream changes needed (vuu-websocket / vuu)

vuu-websocket was not modified. Workarounds are noted.

1. ~~**Module registry cannot point a remote at a different Vuu server.**~~ *Resolved in @vuu-ui 4.0.0-alpha.21.*
   vuu-portal no longer sends connection details in module records. Instead each remote publishes `config.json`
   next to its `mf-manifest.json` (`{connectionId, restUrl, websocketUrl}`, or `{}` for the portal server).
   `RemoteModule` reads it (`remote-module-config`), exchanges the portal user's Keycloak token at `restUrl`
   and opens a ref-counted connection per `connectionId` (`ModuleServerMap`). The trading modules now connect to
   a standalone trading server (`apps/portal-config/src/start-trading.ts`, ports 8192/8544) and the portal
   server only serves the module registry. See #57 for the remaining rough edge.
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
7. ~~**No trading roles in Keycloak bootstrap**~~ *Resolved in this repo:* `scripts/stack/keycloak-realm.ts` creates the
   roles (see #15).
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

15. ~~**No trading roles in the Keycloak realm.**~~ *Resolved in this repo (revised with the alpha.21 split).*
    The trading server has its own confidential Keycloak client, `trader-trading-server`, which owns the server
    roles `trading-view`, `trading-execute` and `trading-supervisor`. The portal user's `vuu-portal` token is
    exchanged for a `trader-trading-server` token (Keycloak standard token exchange), and `packages/oms` reads
    the roles from it with `oms.permissionMode="strict"`. Module gating in the portal uses separate `vuu-portal`
    nav roles (`trading-access`, `trading-execute-access`, `trading-supervisor-access`) that
    `scripts/stack/keycloak-realm.ts` derives from the same user list. vuu-server has no hook to gate a portal
    module on another client's roles, hence the two role sets.
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

## Found in Phase 3 consolidation (P3.11 instrument linking)

37. **`Table` `scrollToKey` is a stub in alpha.20**, so a grid can select and highlight a row chosen elsewhere but
    cannot scroll it into view. InstrumentGrid `followSelection` selects the row (`dataSource.select`) without
    scrolling.
38. **`Table` has no controlled selection**, and `autoSelectRowKey` is read only on mount. *Workaround:*
    InstrumentGrid follows an external selection by sending a `SELECT_ROW` request to its data source and
    ignoring the echo it gets back.
39. **Component state persistence is split.** Inside vuu-layout, `useViewContext().save/load` writes to View state
    (layout JSON). In vuu-portal, `usePersistedState` is a separate store. A component that may run in either
    must try both (`useComponentLinkGroup`). One persistence hook that works with or without a View would help.
40. **vuu-layout keeps View state in a module-level `persistentState` map** (`setPersistentState` /
    `getPersistentState`), so `@vuu-ui/vuu-layout` must be an MF singleton, or a feature's saved state is not found.
    Restoring a saved layout also means walking the JSON and calling `setPersistentState` for each View before
    mounting. *Phase 4:* sharing vuu-layout deadlocks MF startup (#43), so the portal features use portal state
    instead (#50).
41. **`LayoutJSON` is not exported from `@vuu-ui/vuu-layout`** (it lives in vuu-utils `json-types`). The showcase
    declares a local type.
42. **`SelectRequest` is a union**, so `Omit<SelectRequest, "vpId">` (the `DataSource.select` argument) collapses to
    the shared members and cannot be built without a cast.

## Found in Phase 4 (portal integration, `docs/portal-integration.md`)

43. **Sharing `@vuu-ui/vuu-layout` as an MF singleton deadlocks startup.** Its shared chunk bundles
    vuu-data-react, which imports `@vuu-ui/vuu-layout` again, so the share never resolves and the host page stays
    blank. This conflicts with #40. *Workaround:* vuu-layout is not shared; each remote bundles its own copy.
44. **portal-build has no `uniqueName` / chunk-loading-global option.** All remotes built from one package get the
    same JSONP global `rspackChunk_<package>`, so loading two at once fails with
    `__webpack_modules__[moduleId] is not a function`. *Workaround:* `scripts/features/build.ts` renames the global
    to `rspackChunk_<mfScope>` after each build.
45. **The portal requires a unique `mfScope` per module**, so a package that exposes several components still needs
    one remote (one build) per module. *Workaround:* `apps/features/trading` builds 12 remotes from one catalog.
46. **The vuu-portal `ConfigFactory` has no env-var overrides.** Ports, CORS origin and the Keycloak URL can only be
    changed by editing the file. *Workaround:* `start:all` writes `application.stack.conf` from
    `application.conf`.
47. **`cssInline` turns every plain `.css` import in an included path into a `?inline` string.** If the host
    includes its own path, its CSS is never applied. *Workaround:* the host's cssInline includes only shared
    packages.
48. **alpha.20 `PortalShell` has a fixed 56px nav rail, and modules have no icons**, so labels are clipped.
    *Workaround:* `apps/portal-host/src/App.css` widens the rail. A label-only or icon-from-module option would help.
49. **There is no server-side state persistence.** `usePersistedState` defaults to `LocalStoragePersistenceBackend`,
    so saved layouts and link groups are per browser and lost in a fresh profile. A REST persistence backend in
    vuu-portal would make layouts follow the user.
50. **A shared singleton library cannot see a remote's `View`s.** `@heswell/trading-ui` is bound to the host's
    vuu-layout (#43), so `useViewContext()` in a remote returns the host's default context. *Workaround:*
    `useComponentLinkGroup` stores link groups in the module's portal state (`trading.linkGroup.<id>`).
51. **The vuu-utils global `vuuConfig: Promise<VuuConfig>` lacks the auth fields** (`clientId`, `realm`, ...) that
    `PortalShell` needs, so hosts cast. Declaring another global clashes with it.
52. **`@vuu-ui/vuu-icons` ships no type declarations.** *Workaround:* `apps/portal-host/src/vuu-icons.d.ts`.
53. **Restoring vuu-layout JSON needs the component registry, which is per bundle.** A remote cannot restore a
    layout containing components it did not register, so the workspace saves View states but not its
    arrangement.
54. **`vuu.auth.cors.allowedOrigin` takes a single origin**, so a host served from two origins (e.g. localhost and
    a LAN name) needs two configs.
55. **`PersistedStateAPI` has no delete or clear.** *Workaround:* `save(key, null)`, and the whole document is
    read with `load()` to find keys by prefix.
56. **A parent module cannot reset its child modules' persisted state.** The children are separate modules with
    their own state documents. The workspace's Reset layout clears only its own keys.

## Re-tested against @vuu-ui 4.0.0-alpha.21

#23 and #29–#56 (the vuu-ui items) were re-checked against alpha.21 and portal-build 0.3.0. None is fixed yet,
so every workaround stays:
`scrollToKey` still only logs (#37); `Table` still has no controlled selection (#38); `LayoutJSON` (#41) and
`pluginCssInline` (#23) are still not exported; `SelectRequest` is still a union (#42); vuu-data-react still
imports vuu-layout (#43); portal-build 0.3.0 has no chunk-loading-global option (#44); the `PortalShell` rail is
still a fixed 56px (#48; alpha.21 added a `banners` grid row, which `App.css` now includes); `vuuConfig` (#51)
and the `@vuu-ui/vuu-icons` main entry (#52) still lack types; `PersistedStateAPI` still has no delete (#55);
`NotificationsProvider` (#35) and `connectionStatusFor` (#36) are unchanged.

## Found in the alpha.21 upgrade (trading server split)

57. **Every remote must publish `config.json`.** `RemoteModule` treats a missing file (404) as an error, so a
    remote that uses the portal server still needs `{}`. The file is also static per build, while the trading URLs
    depend on where the stack runs, and portal-build 0.3.0 has no option to emit it (its remote target ignores
    `manifest`). *Workaround:* `scripts/features/build.ts` writes `dist/<key>/config.json` from `TRADER_*` env
    vars, and `scripts/stack/serve.ts` regenerates it per request from the current env. Treating 404 as `{}`
    and a portal-build `remoteConfig` option would help.
58. **`[ConnectionManager] subscribed message received, viewport not found`** is logged when navigating between
    modules: a subscribe ack arrives after the component unmounted. It looks harmless but is noisy.
59. **The `PortalAppSwitcher` nav groups are collapsed by default** (state persisted as `nav/expanded`), so a new
    user sees only group headers. A default-expanded option would help a portal with few groups.
60. **The `@vuu-ui/*` packages depend on exact alpha versions**, and `@heswell/vuu-data-engine-local` pins
    alpha.20, so bun installs two copies of `@vuu-ui/core` (two React contexts) unless the root `package.json`
    `overrides` every `@vuu-ui/*` package.
