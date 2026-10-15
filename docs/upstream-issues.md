# Upstream changes needed (vuu-websocket / vuu)

Workarounds are noted. Resolved issues are struck through.

1. ~~**Module registry cannot point a remote at a different Vuu server.**~~ *Resolved in @vuu-ui 4.0.0-alpha.21.*
   vuu-portal no longer sends connection details in module records. Instead each remote publishes `config.json`
   next to its `mf-manifest.json` (`{connectionId, restUrl, websocketUrl}`, or `{}` for the portal server).
   `RemoteModule` reads it (`remote-module-config`), exchanges the portal user's Keycloak token at `restUrl`
   and opens a ref-counted connection per `connectionId` (`ModuleServerMap`). The trading modules now connect to
   a standalone trading server (`apps/portal-config/src/start-trading.ts`, ports 8192/8544) and the portal
   server only serves the module registry. See #57 for the remaining rough edge.
2. ~~**`@heswell/vuu-server`, `service-utils`, `vuu-portal` are unpublished**~~ *Resolved: fixed in vuu-websocket#85; vuu-server 3.1.0 / vuu-portal 2.0.0 / service-utils 1.1.0.*
   They (and `@heswell/module-admin`) are on npm; trader depends on them directly. The symlink script
   (`scripts/link-vuu-websocket.ts`, `link:vuu`, postinstall, `VUU_WEBSOCKET_DIR`) and CI's vuu-websocket checkout are gone.
3. ~~**vuu-portal exports** do not include `loadModuleState`/`loadModuleAdminRole`; deep import used.~~ *Resolved: fixed in vuu-websocket#85; vuu-server 3.1.0 / vuu-portal 2.0.0 / service-utils 1.1.0.*
   The root exports them, plus `createModuleRegistry`, `ModuleDiscoveryModule`, `createPortalApplication` and
   `loadDefaultModules`; all deep imports are gone.
4. ~~**`PortalMain` hard-codes its modules**; no hook to add modules. Composite launcher duplicates its ~20 lines.~~
   *Resolved: fixed in vuu-websocket#85; vuu-server 3.1.0 / vuu-portal 2.0.0 / service-utils 1.1.0.* Everything (ports, websocket path, auth, admin role, module files) comes from the conf, so trader runs
   the stock `@heswell/vuu-portal/main` (or `bunx vuu-portal --config apps/portal-config/application.conf`);
   `start-portal.ts` is deleted.
5. **Portal host UI is not published** (only `@vuu-ui/portal-build` is). It must be built from finos/vuu.
6. ~~**vuu-server / service-utils / vuu-portal do not typecheck**~~ *Resolved: fixed in vuu-websocket#85; vuu-server 3.1.0 / vuu-portal 2.0.0 / service-utils 1.1.0.*
   The packages ship `.d.ts`; `scripts/vuu-types.ts`, `.vuu-types/` and `tsconfig.typecheck.json` are deleted and
   `bun run typecheck` is plain `tsc --noEmit` (with the existing `skipLibCheck: true`).
7. ~~**No trading roles in Keycloak bootstrap**~~ *Resolved in this repo:* `scripts/stack/keycloak-realm.ts` creates the
   roles (see #15).
8. ~~**Config paths must be relative** (`getPath` rejects absolute), which makes ad-hoc configs outside the config
   directory awkward.~~ *Resolved: fixed in vuu-websocket#85; vuu-server 3.1.0 / vuu-portal 2.0.0 / service-utils 1.1.0.* Absolute and `~/` paths are accepted; `start:all` no longer writes conf copies
   next to the originals.

## Found in Phase 1 (exchange simulator)

9. ~~**`ModuleFactory.addJoinTable` has no `ServiceFactory` parameter**, so a join table cannot have an RPC
   handler (or custom `ViewPortDef`).~~ *Resolved: fixed in vuu-websocket#86; vuu-server 3.2.0.*
   `addJoinTable(func, serviceFactory)` registers the factory under the realised join's name. `ExchangeModule`
   (`instrumentPrices`) and `OmsModule` (`positionPrices`) pass it directly; the `module.viewPortDefs.set(...)`
   calls after `asModule()` are gone.
10. ~~**The `ServiceFactory` is invoked on every `CREATE_VP` and every `GET_TABLE_META`**, so a new `RpcHandler`
    per call, with typeahead re-registered each time.~~ *Resolved: fixed in vuu-websocket#86; vuu-server 3.2.0.*
    `GET_TABLE_META` reads `tableDef.columns`; the factory runs once per viewport on `CREATE_VP` and typeahead is
    shared per table container. The per-table-container `WeakMap` handler caches are gone: each viewport gets its
    own `ExchangeAdminRpcHandler` / `OmsRpcHandler`. Neither keeps cross-viewport state (the simulator and
    `OmsService` hold the orders and permissions, the `TableContainer` holds edit-session tables), so no shared
    handler is needed.
11. ~~**Menu RPCs are not supported server-side** (already noted in `docs/protocol-parity.md`). Admin actions
    are plain `RPC_REQUEST`s in a `VIEWPORT_CONTEXT`, so the UI needs a custom affordance rather than a context menu.~~
    *Resolved: fixed in vuu-websocket#89; vuu-server 3.3.0.* `VIEW_PORT_MENUS_SELECT_RPC` and the table / row / cell
    menu RPCs dispatch to handlers on the menu items (`protocol-parity.md` §1.7). Trader declares no server menus
    yet; the vuu-ui client gaps are 63–66.
12. ~~**Noisy `console.log`** in `ModuleFactory` (it dumps the whole module including `viewPortDefs`), `TableContainer`,
    `ViewportContainer` and `CoreServerApi` on every create, plus the `[SESSION] ... has not responded` warnings. This
    drowns test and bench output. A log level (or `debug`) would help.~~ *Resolved: fixed in vuu-websocket#90;
    service-utils 1.2.0 / vuu-server 4.0.0.* A leveled logger (`getLogger(name)`, `setLogLevel`, `setLogSink`,
    `resetLogging`, re-exported by vuu-server) configured by `vuu.log.level` / `vuu.log.levels.<name>` or
    `VUU_LOG_LEVEL`. Every trader conf has `vuu.log.level=${?VUU_LOG_LEVEL}`, `start:all` maps `TRADER_LOG_LEVEL`,
    the test preload defaults to `silent`, the bench sets `warn`, and the OMS logs through `getLogger("trader.oms")`.
13. ~~**`@heswell/hft-limit-order-book` `modify`** (fork of nodejs-order-book): `modify(id, {price?, size?})` re-inserts
    the order, so it **loses time priority even when only reducing size**, which differs from real exchanges. It also
    resets `timeInForce`/`stpMode` to defaults.~~ *Resolved: heswell/hft-limit-order-book#3; hft-limit-order-book 2.0.0.* A size decrease at the same price now resizes
    in place and keeps priority (`priorityKept: true`); a price change or size increase re-queues at the back of the
    level. TIF, postOnly, STP, account, owner, meta and OCO links are preserved, and the exported `OrderUpdate` type
    replaced trader's cast in `InstrumentBook.modify`. The gateway's AMEND `REPLACED` report carries `priorityKept`,
    and the "amend loses priority" caveats are gone. Trade ids from `onTrade` are still per book, so the simulator
    still issues its own global `TR<n>` ids (by design, not an issue).
14. ~~**The REST auth server now requires TLS** (`RestServer`: "REST HTTPS server requires SSL"), so the Phase 0
    stand-alone config (`vuu.ssl=false`) no longer started.~~ *Resolved: fixed in vuu-websocket#88; vuu-server 3.3.0.*
    With `vuu.auth.mode="permissive"`, `vuu.ssl=false` serves REST as `http://` and the websocket as `ws://`. The
    stand-alone exchange-sim and OMS configs use it (no dev cert), and the server tests start them on ephemeral ports
    and log in at `http://localhost:<port>/api/authn`. The Keycloak (`start:all`) configs keep TLS.

## Found in Phase 2 (OMS)

15. ~~**No trading roles in the Keycloak realm.**~~ *Resolved in this repo (revised with the alpha.21 split).*
    The trading server has its own confidential Keycloak client, `trader-trading-server`, which owns the server
    roles `trading-view`, `trading-execute` and `trading-supervisor`. The portal user's `vuu-portal` token is
    exchanged for a `trader-trading-server` token (Keycloak standard token exchange), and `packages/oms` reads
    the roles from it with `oms.permissionMode="strict"`. Module gating in the portal uses separate `vuu-portal`
    nav roles (`trading-access`, `trading-execute-access`, `trading-supervisor-access`) that
    `scripts/stack/keycloak-realm.ts` derives from the same user list. vuu-server has no hook to gate a portal
    module on another client's roles, hence the two role sets.
16. ~~**`JoinTableDef` constructor drops `permissionFunction`.**~~ *Resolved: fixed in vuu-websocket#86;
    vuu-server 3.2.0.* `JoinTableDef` passes every remaining `TableDefConfig` field through.
    `toServerJoinFactory(positionPrices, {permissionFunction})` sets it in the config, so `OmsModule` no longer
    wraps the join factory.
17. ~~**`editCell` (CreateSessionTableRpcHandler) edits the source table when the viewport is not an edit session.**
    Any client with an RPC-capable viewport can then overwrite rows directly.~~ *Resolved: fixed in vuu-websocket#91; vuu-server 4.0.0.*
    Source edits are refused unless `canEditSource` is overridden; key, system and unknown columns are refused and
    values are type-checked; rows hidden by the permission filter cannot be edited, deleted, selected or copied into a
    session; cross-session viewports and sessions of sessions are refused. `OmsRpcHandler` only overrides
    `isEditableColumn` (`quantity` / `price` on `parentOrders` session tables), `validateCellEdit` (order rules) and
    `canSaveSession` (trading-execute), scopes sessions to `parentOrders` and refuses `addRow`.
18. ~~**The base `handleEndEditSession` ignores the result of `applySessionSave`.** It always reports success and drops
    the session, so a subclass cannot report per-row failures.~~ *Resolved: fixed in vuu-websocket#91; vuu-server 4.0.0.* A failed save, a
    `canSaveSession` veto or a throw returns `ERROR_RESULT`, rolls the source back and keeps the session open.
    `OmsRpcHandler` now just overrides `applySessionSave` (no `handleEndEditSession` override); the UI discards the
    session after a failure (`openOrderEditSession` / `editOrdersInSession`). See 68.
19. ~~**exchange-sim has no trading session / close.**~~ *Resolved in trader (exchange-sim).* exchange-sim has a
    scheduled trading session (`sessionOpen` / `sessionClose` UTC, `preOpenMinutes`, or a fast simulated day with
    `sessionDayMs`) with PRE_OPEN / CONTINUOUS / CLOSED phases published on `prices.phase`. Working DAY orders expire
    at the close, new orders and amends are rejected with `MARKET_CLOSED` while closed, and the `setMarketPhase`
    admin RPC forces a phase. By default no session is configured, so dev and e2e runs are always open.
    `OmsEngine.endOfDay()` still expires DAY orders on demand.

## Found in Phase 3 wave 1 (UI foundation)

20. ~~**`@heswell/vuu-data-engine-local` has import-time side effects.**~~ *Resolved: vuu-websocket#96; vuu-data-engine-local 3.0.0.* Importing it creates no
    modules or timers; `registerDemoModules(engine)` is explicit and `/legacy` keeps the old behaviour. Trader never
    used the demo modules, so nothing changed; a Bun script importing it now exits on its own (it still needs a DOM;
    see 77).
21. ~~**engine-local's `tableContainer` is global and keyed by bare table name**~~ *Resolved: vuu-websocket#96; vuu-data-engine-local 3.0.0.* Each
    `LocalEngine` (`createLocalEngine({modules})`) has its own container keyed by `{module, table}`, and
    `createLocalVuuServer` takes the `engine`. `createTradingTestData` creates one engine per instance (`td.engine`),
    no longer adds tables to the global container, and disposes with `engine.dispose()`. The "one live instance at a
    time" restriction is gone; a test runs two instances side by side.
22. ~~**engine-local's default edit-session RPC services cannot be overridden** per table~~ *Resolved: vuu-websocket#96; vuu-data-engine-local 3.0.0.*
    `VuuModule.editHooks` replaced trader's `beforeSessionSave` hook (and its `vuuAction` clearing):
    `parentOrdersEditHooks` makes only `quantity`/`price` editable (in a session), validates edits like the OMS,
    compares every column for staleness, checks `canExecute` in `canSaveSession`, and routes edits to `amendOrder` and
    deletes to `cancelOrder` in `applySessionSave`, like the server's `OmsRpcHandler`. A stale save throws vuu-ui's
    `StaleUpdateError`, which `editSessionAmend` maps to `StaleOrderEditError` as for the server. engine-local's
    `deleteRow` still differs; see 76.
23. **`@vuu-ui/portal-build` `cssInline` covers only vuu packages by default, and `pluginCssInline` is not
    exported.** Components that inject CSS (`useComponentCssInjection` with `import css from "./X.css"`) need
    `"cssInline": {"include": ["/packages/trading-ui/", "/apps/features/"]}` in every feature's
    portal-build.json. Apps that don't use portal-build (the showcase) must reimplement the rewrite
    (`apps/showcase/css-inline-loader.cjs`). Exporting the plugin would let other rsbuild apps reuse it.
24. ~~**`@heswell/hft-limit-order-book` imports `randomUUID` from `node:crypto`**, which breaks browser bundles of
    exchange-sim.~~ *Resolved: heswell/hft-limit-order-book#3; hft-limit-order-book 2.0.0.* It uses `globalThis.crypto`. The `@heswell/trading-test-data/shims/node-crypto`
    shim, its export and the showcase's `NormalModuleReplacementPlugin` are gone.
25. ~~**The REST auth CORS config allows a single origin** (`vuu.auth.cors.allowedOrigin`), so dev apps on other
    ports cannot authenticate directly.~~ *Resolved: vuu-websocket#95; vuu-server 4.2.0 / vuu-portal 2.1.2.* `vuu.auth.cors.allowedOrigins` takes a list. The
    standalone trading and exchange-sim confs list the showcase (`localhost`/`127.0.0.1:5001`), and the showcase
    calls the trading server directly; its `/remote/trading/*` dev-server proxy is gone.
26. ~~**engine-local `subscribe` requires a vuu-utils `Range` object**~~ *Resolved: vuu-websocket#96; vuu-data-engine-local 3.0.0.* A plain `{from, to}` is
    accepted; `tradingTestData.test.ts` uses one. Code typed against vuu-ui's `DataSource` still needs `Range(...)`
    (see 75).
27. ~~**Permissive auth rejects an empty password** (HTTP 401).~~ *Resolved: vuu-websocket#95; vuu-server 4.2.0 / vuu-portal 2.1.2.* An empty or missing password is
    accepted (`vuu.auth.permissive.users` is still an allow-list when set), and the token in both the JSON body and
    the `vuu-auth-token` header (exposed for CORS) is documented. `connectToVuuServer`'s password is optional and it
    reads the body; the showcase and the server tests send no password.
28. ~~**`positions` / `positionPrices` have no sector (or any instrument static) column**~~ *Resolved in trader.*
    `instruments.sector` carries a GICS sector for every ric, and the OMS denormalises `exchange` and `sector` onto
    `positions` (so `positionPrices` has them too). PositionsView defaults to grouping by currency / sector.
29. **No cross-table tree / LinkedTableView in alpha.20**, and `Table.onSelectionChange` reports key-based requests
    (`SELECT_ROW`, `SELECT_ROW_RANGE`, ...) rather than the selected row set, so ranges can only be resolved with a
    second data source. OrderBlotter uses a child-orders detail panel and a mirror subscription
    (`useTableSelectedKeys`).
30. **No VWAP aggregation** (vuu aggregation types: sum, average, count, high, low, distinct). FillsBlotter sums
    `quantity` and `notional` and computes `notional / quantity` in a cell renderer.
31. **Editable Table cells need the edit-session snapshot data source as the Table's own source**, which loses live
    updates, so inline editing is impractical on a ticking blotter. `editOrdersInSession` drives the same server edit
    session (`beginEditSession` / `editCell` / `endEditSession`) programmatically. The OrderBlotter amend dialog uses
    `amendOrder` by default; with `useEditSession` (the Orders and Trader Workspace features) the dialog begins a
    session when it opens and saves it on Amend (`openOrderEditSession`).
32. **Custom cell renderers are looked up by name in a global registry** and the package `sideEffects` only lists
    CSS, so each component module must call `registerTradingCellRenderers()` at import time.
33. ~~**A `LEFT JOIN` row without a price shows `0` (not empty) for numeric columns**~~ *Resolved in trader;
    vuu-websocket#97; vuu-viewport 1.1.5.* The servers already return null for unmatched LEFT JOIN columns; the 0s
    came from exchange-sim's `MarketDataPublisher`, which pre-inserted a `prices` row with numeric fields 0. It now
    writes null for bid/ask/sizes when a side is empty and for last/open/high/low/vwap/change until the first trade,
    and relational filters no longer match null (vuu-viewport 1.1.5). The sparkline `ignoreZero` option and the
    grid's `simulated = true` default are removed.
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
46. ~~**The vuu-portal `ConfigFactory` has no env-var overrides.**~~ *Resolved: fixed in vuu-websocket#85; vuu-server 3.1.0 / vuu-portal 2.0.0 / service-utils 1.1.0.*
    `key=${?VAR}` / `${VAR}` substitutions: trader's confs end with `${?VUU_*}` lines and `start:all` sets those
    per process from the `TRADER_*` settings (`scripts/stack/config.ts` `serverEnv`). The generated
    `application.stack.conf` / `application.trading.stack.conf` are gone.
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
54. ~~**`vuu.auth.cors.allowedOrigin` takes a single origin**, so a host served from two origins (e.g. localhost and
    a LAN name) needs two configs.~~ *Resolved: vuu-websocket#95; vuu-server 4.2.0 / vuu-portal 2.1.2.* Both portal-config confs list the host and features origins
    via `localhost` and `127.0.0.1`. `start:all` passes the list derived from the `TRADER_*` settings as
    `VUU_CORS_ALLOWED_ORIGINS` and adds the host origins to the realm's vuu-portal redirect URIs, so the host works
    from either origin.
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
60. **The `@vuu-ui/*` packages depend on exact alpha versions**, and ~~`@heswell/vuu-data-engine-local` pins
    alpha.20, so bun installs two copies of `@vuu-ui/core` (two React contexts) unless the root `package.json`
    `overrides` every `@vuu-ui/*` package.~~ *Resolved on the @heswell side: vuu-websocket#93; engine-local 2.1.0
    and every other @heswell package peer `@vuu-ui/*` at `^4.0.0-alpha.20`, and the root `overrides` are gone.*
    The finos side remains: the `@vuu-ui/*` packages still depend on (and `vuu-utils` peers `vuu-filter-parser` at)
    exact sibling versions. That is consistent while everything is on alpha.21, but a mixed version in a future
    upgrade would install duplicates again, so all `@vuu-ui/*` packages must be bumped together. The
    `vuu-utils` ⇄ `vuu-filter-parser` peer cycle gives bun two store variants of `vuu-filter-parser` (same version;
    also on main before this change).

## Found in the vuu-server 3.2.0 / 3.3.0 upgrade

61. ~~**The edit-session stale-row check silently does nothing without a `vuuUpdatedTimestamp` column.**~~
    `EndEditSessionRpcHandler.prepareSessionSave` compares the session change's `lastUpdateTimestamp` with the
    source row's `vuuUpdatedTimestamp`; on a table without that column both are `undefined`, so every row passes
    and `force` has no effect. The OMS tables don't declare the Vuu default columns, so the documented OMS stale
    check had never fired. *Workaround:* `OmsRpcHandler.handleEndEditSession` also compares the session copy with
    the live `parentOrders` row on every column the user did not edit (an amend bumps `version`, a fill moves
    `cumQty`) and fails with `stale update: <orderIds> ...` unless `force: true`. Upstream should either require the
    column for edit sessions or fall back to a row comparison. *Resolved: fixed in vuu-websocket#91; vuu-server 4.0.0.* Each source row is
    snapshotted when it is copied into the session and every column is compared at save; the error is
    `stale update` and each stale row's `vuuMsg` is `stale:<key>:<cols>`. The OMS workaround is gone. `OmsRpcHandler`
    does not override `getStaleColumns`: `parentOrders` rows change only on order events (ack, fill, replace, cancel,
    reject, expire), and each of them should make an open amend stale. The UI shows
    "Order <ids> changed since you started editing; check it and amend again".
62. ~~**`@heswell/vuu-portal` 2.0.0 pins `@heswell/vuu-server` 3.1.0**, so bun installs a second copy next to
    trader's 3.3.0. It is harmless today (the portal server only does module discovery; the trading modules run
    on the trading server with 3.3.0), but a vuu-portal release with a `^3.3.0` range would avoid it.~~
    *Resolved: vuu-portal 2.1.0.* It peers `@heswell/vuu-server` `^3.1.0 || ^4.0.0` and `@heswell/vuu-table`
    `^1.0.1`; trader depends on both directly (root and `apps/portal-config`), and there is one vuu-server 4.0.0 in
    the install. See 67 for its `@vuu-ui` peer pin.
63. **vuu-ui `useVuuMenuActions` ignores `CLOSE_DIALOG_ACTION` and `NO_ACTION`** (alpha.21). It only handles
    `SHOW_NOTIFICATION_ACTION` and `OPEN_DIALOG_ACTION`, so a menu handler cannot close an open dialog. `NO_ACTION`
    is harmless, but `CLOSE_DIALOG_ACTION` from vuu-server 3.3.0 has no effect unless the caller passes
    `onRpcResponse`.
64. **vuu-ui only acts on `OPEN_DIALOG_ACTION` for session tables** (`isSessionTableActionMessage` /
    `isCustomComponentActionMessage` both require `isSessionTable(action.table)`), so a menu cannot open a dialog
    on a plain table.
65. **Menu `SHOW_NOTIFICATION_ACTION` is always a "success" toast.** The protocol action has only `message` and
    `title`, no type or severity, so a handler cannot report a warning or failure as a notification. Return a
    `VIEW_PORT_MENU_REJ` (throw) for errors, but see 66.
66. **vuu-ui does not surface `VIEW_PORT_MENU_REJ`.** `menuRpcCall` resolves with the reject message, and
    `useVuuMenuActions` ignores it unless the caller passes `onRpcResponse`, so a failed menu action is silent for
    the user.

## Found in the vuu-server 4.0.0 upgrade

67. ~~**The @heswell packages peer `@vuu-ui/*` at exactly `4.0.0-alpha.20`.**~~ vuu-server 4.0.0, service-utils 1.2.0,
    vuu-table, vuu-viewport 1.1.3 and vuu-portal 2.1.0 all peer `@vuu-ui/vuu-protocol-types` (and friends) at
    `4.0.0-alpha.20`; trader is on alpha.21. Without trader's root `overrides`, bun warns "incorrect peer dependency
    @vuu-ui/vuu-protocol-types@4.0.0-alpha.21" and npm fails with ERESOLVE. With the overrides there is a single
    alpha.21 copy and no warning. A range (`>=4.0.0-alpha.20 <5`) would avoid it. Related to 60.
    *Resolved: vuu-websocket#93; vuu-server 4.1.0, vuu-portal 2.1.1, vuu-table 1.0.2, vuu-viewport 1.1.4,
    vuu-data-engine-local 2.1.0, service-utils 1.2.1.* They peer `@vuu-ui/*` at `^4.0.0-alpha.20` (vuu-server's
    `vuu-utils` moved from a dependency to a peer), so every workspace that uses vuu-server or engine-local lists
    `vuu-utils`, `vuu-data-types` and `vuu-protocol-types` directly at alpha.21. The root `overrides` are removed;
    the lockfile has one alpha.21 copy of each `@vuu-ui/*` package, bun reports no peer warnings and an npm
    install of the same set has no ERESOLVE. vuu-server's `@types/bun >=1.3.0` peer is optional
    (`peerDependenciesMeta`), so browser-only packages and npm consumers are unaffected.
68. ~~**`applySessionSave(sessionTable, prepared)` gets no `RequestContext`**~~, although `canSaveSession` does. An OMS
    must send each amend / cancel as the saving user, so `OmsRpcHandler` remembers the user from `canSaveSession` in
    a `WeakMap` keyed by `prepared`. That only works because its `canSaveSession` is synchronous (an async result
    makes the base class prepare the save again). Passing `ctx` to `applySessionSave` would remove it.
    *Resolved: vuu-websocket#94; vuu-server 4.1.0.* `prepareSessionSave` and `applySessionSave` receive the
    `RequestContext`; `OmsRpcHandler.applySessionSave` takes the user from `ctx` and the `WeakMap` is gone.
69. ~~**A cross-session viewport id is refused as an internal error.**~~ `getViewportForSession` throws, so
    `CoreServerApiHandler` logs the refusal at `error` with a stack trace and the client gets
    `Failed to process request <id>`. A refused request is a client error; an `ERROR_RESULT` such as
    "viewport not found" without the stack would keep server logs clean. The OMS test captures it with `setLogSink`.
    *Resolved: vuu-websocket#94; vuu-server 4.1.0.* Expected refusals log at `warn` without a stack and the client
    gets `viewport not found <id>`; the OMS test asserts that result and no longer captures the log.
70. **`VuuDataSource.beginEditSession` drops the `connectionId`** (`@vuu-ui/vuu-data-remote` 4.0.0-alpha.21). It
    builds the session data source with `new VuuDataSource({...this.config, table, viewport})`, so it uses the base
    class with the default `"portal"` connection rather than the source's connection-bound subclass
    (`createSessionDataSource` passes `connectionId`). Under the portal, the session table's `GET_TABLE_META` /
    `CREATE_VP` went to the portal server instead of trading (and, before vuu-server 4.1.0, crashed it; see 71). `openOrderEditSession`
    rebuilds the session with `source.constructor` and ends it with the `endEditSession` RPC: the rebuilt instance
    is not linked to its source, so its own `endEditSession` would send a resume for the removed viewport.
71. ~~**vuu-server exits on a request for an unknown table.**~~ `processGetTableMetaRequest` and
    `processCreateViewPortRequest` call `TableContainer.getTable`, which throws `[TableContainer] no table <name>`;
    the throw is not caught, so any client can stop the server with one message (seen with 4.0.0 in the e2e run
    via 70). `ViewportContainer.create` throws `[ViewportContainer] no table` the same way for another session's
    session table. Root cause: the message handler does `try { return this.handleViewServerMessage(...) }`
    without `await`, so a rejection from the async handler escapes the `catch` as an unhandled rejection. Awaiting
    it (and answering with an `ERROR_RESULT` / `TABLE_NOT_FOUND`) would fix all of these. No trader workaround
    beyond fixing 70. *Resolved: vuu-websocket#94; vuu-server 4.1.0.* A failing request answers with
    `CREATE_VP_REJECT`, `ERROR_RESULT`, `VIEW_PORT_MENU_REJ`, `*_REJECT` or `ERROR` and keeps the channel open; an
    `unhandledRejection` guard is on by default (`vuu.server.unhandledRejectionGuard=false` turns it off). Trader
    had no guards of its own to remove.
72. ~~**A second login silently evicts the user's first session.**~~ `ClientSessionContainer` defaults to
    `maxSessionsPerUser = 1` (not settable from conf). Logging in again drops the oldest session from the
    container without closing its channel or removing its session tables, so the first tab only learns from
    "Invalid session" on its next request. It then reconnects and re-creates its session-table viewport, which
    hits 71 and stops the server. Closing the evicted channel (and its session tables), and a
    `vuu.server.maxSessionsPerUser` setting, would fix it. ~~Trader users should use one tab per user for now.~~
    *Resolved: vuu-websocket#94; vuu-server 4.1.0.* An evicted session is closed with code 4001
    "session evicted: user logged in again" and its viewports and session tables are removed.
    `vuu.server.maxSessionsPerUser` (default 1) and `vuu.server.sessionLimitPolicy` (`evict-oldest`, or
    `reject-new`, which closes the new channel with 4003) are configurable. Trader sets 5 / `reject-new` on both
    servers (env `VUU_MAX_SESSIONS_PER_USER` / `VUU_SESSION_LIMIT_POLICY`), not `evict-oldest`, because of 73;
    see [Sessions per user](portal-integration.md#sessions-per-user).

## Found in the vuu-server 4.1.0 upgrade

73. **vuu-ui ignores the WebSocket close code, so `evict-oldest` evicts every tab in turn.** (finos `@vuu-ui/core`
    `VuuConnectionRegistry`, `@vuu-ui/vuu-data-remote` `WebSocketConnection`, 4.0.0-alpha.21.) The registry
    reconnects after `retryIntervals` (1 s, 2 s, …) on any `disconnected` or `failed` status, and `onclose` drops
    the code and reason. An evicted tab (`4001`) therefore logs in again a second later and evicts the user's
    next oldest session. With more tabs than `maxSessionsPerUser` this goes round the tabs forever: each one is
    disconnected, loses its viewports and shows only trader's generic "Disconnected from the trading server"
    banner (one tab also logs "Viewport server id not found"). Seen with 6 and 7 tabs against a limit of 5.
    Not reconnecting on `4001`, `4003` or `4004`, and telling the user why (e.g. "signed in from another tab"),
    would fix it. *Workaround:* trader uses `sessionLimitPolicy="reject-new"`.
74. **A login refused at the session limit leaves a blank page.** (finos `@vuu-ui`, portal shell.) Under
    `reject-new` the extra tab's portal connection is closed with `4003` and a text frame
    `maximum sessions (N) reached for user X`, which `isLoginErrorMessage` / `InvalidLoginMessages` do not
    recognise. The shell renders nothing (no banner or message) and never retries, even after other tabs close.
    Showing the reason, and retrying or offering a retry, would fix it. *Workaround:* trader allows 5 sessions per
    user so this is rare. For module (trading) connections, `createResilientConnectionRegistry` now retries with
    backoff and shows "Connecting…" until a session is free (trader upstream issues 83, 84). The portal connection
    goes through the same registry, so it is retried too, but the shell stays blank until it connects.

## Found in the vuu-server 4.2.0 / engine-local 3.0.0 upgrade

75. **vuu-ui's `DataSource.subscribe` type requires a full `Range`** (`@vuu-ui/vuu-data-types`, 4.0.0-alpha.21:
    `equals`, `reset`, `withBuffer`, ...), although engine-local and `VuuDataSource` only read `from`/`to`. Code
    typed against `DataSource` (`useDataSourceRows`, `editSessionAmend`, `useTradingDataSource.test.tsx`) keeps
    `Range(from, to)`. Accepting `{from, to}` in the type would remove them.
76. ~~**engine-local's `deleteRow` differs from vuu-server's.**~~ *Resolved: vuu-websocket#97;
    vuu-data-engine-local 4.0.0.* `deleteRow` / `deleteSelectedRows` now mark the session row
    `vuuAction = "deleteRow"` in every mode and refuse `deleteRow` outside a session. The `TradingLocalModule`
    override is removed; tests cover delete-in-session -> `cancelOrder`. (vuu-websocket, vuu-data-engine-local 3.0.0.) With
    vuu-ui's default `mode: "hard"` it removes the row from the session table, so `applySessionSave` never sees the
    delete; outside an edit session it deletes the source row. vuu-server marks the row `vuuAction = "deleteRow"` in
    either mode and refuses `deleteRow` outside a session. *Workaround:* `TradingLocalModule` overrides the
    `deleteRow` service with the server's behaviour.
77. ~~**Importing `@heswell/vuu-data-engine-local` needs a DOM.**~~ *Resolved: vuu-websocket#97;
    vuu-data-engine-local 4.0.0.* The React/DOM pieces moved to `@heswell/vuu-data-engine-local/react`; trader's
    `createTradingLocalServer` moved to `@heswell/trading-test-data/react`, and trading-test-data tests run in
    `test:server` without happy-dom. (vuu-websocket, vuu-data-engine-local 3.0.0.) Its
    entry imports `@vuu-ui/vuu-ui-controls`, which creates a `ResizeObserver` at import, so a plain Bun/Node script
    fails with `ResizeObserver is not defined`. *Workaround:* tests preload `scripts/dom-test-setup.ts` (happy-dom).

## Found in the engine-local 4.0.0 upgrade

78. ~~**engine-local 4.0.0's DOM-free main entry still calls a global `requestAnimationFrame`.**~~ *Resolved:
    vuu-websocket#98; vuu-data-engine-local 4.1.0.* `VuuModule.handlePostSubscribeActivities` (and
    `EngineDataSource`) use `requestAnimationFrame` when it exists and `setTimeout(cb, 0)` otherwise. The test shim
    in `packages/trading-test-data/__tests__/helpers.ts` is removed. The same release lets `createJoinTable` take a
    declared `schema` (column order preserved), so `createTradingTestData` now builds `instrumentPrices` and
    `positionPrices` with `createJoinTable` instead of a hand-built `@heswell/vuu-table` `JoinTable` (both join on
    `ric`/`ric`). (vuu-websocket, vuu-data-engine-local 4.0.0.) `VuuModule.handlePostSubscribeActivities` schedules
    with a bare `requestAnimationFrame`, so the first `subscribe` in plain Bun/Node throws `ReferenceError:
    requestAnimationFrame is not defined`. Falling back to `setTimeout` when rAF is missing would fix it.
    *Workaround:* `packages/trading-test-data/__tests__/helpers.ts` installed a `setTimeout`-based shim.

## Found in the engine-local 4.1.0 upgrade

79. ~~**`createJoinTable` gives no typed way to dispose the join.**~~ *Resolved: vuu-websocket#99;
    vuu-data-engine-local 4.2.0.* `createJoinTable` returns a `JoinTableHandle` (`engineTable` typed `JoinTable`),
    `Table.destroy()` detaches a join, and `engine.dispose()` disposes the modules, which destroy their join tables.
    `createTradingTestData` dropped the cast and the manual destroy; a test checks source updates stop reaching the
    joins after `dispose()`. (vuu-websocket, vuu-data-engine-local 4.1.0.)
    The returned `Table`'s `engineTable` is an `@heswell/vuu-table` `JoinTable` at runtime but is typed as the base
    engine `Table`, so `destroy()` (which detaches the join's listeners from its source tables) is not visible, and
    `Table` has no `destroy()` of its own. A `Table.destroy()` that forwards to the engine table, or a `JoinTable`
    type on joins, would fix it. *Workaround:* `createTradingTestData`'s `joinTableFor` narrows `engineTable` with a
    structural `{ destroy(): void }` cast and calls it on `dispose()`.
80. ~~**`createJoinTable({ schema })` adds `rangeLimits` the declared schema did not have.**~~ *Resolved:
    vuu-websocket#99; vuu-data-engine-local 4.2.0.* The join's `Table.schema` is now the declared schema (defaults
    go to `Table.rangeLimits`), so the modules publish each table's own `schema` again. (vuu-websocket,
    vuu-data-engine-local 4.1.0.) A declared schema without `rangeLimits` gets the engine default
    (`maxRangeEnd: 1000000, maxRangeWidth: 1000`), so the join's `Table.schema` no longer matches the schema the
    server returns in TABLE_META_RESP, while plain `createTable`/`new Table(schema)` keep it unchanged. Preserving
    the declared schema as given would fix it. *Workaround:* `createTradingTestData` publishes the declared
    `getTradingSchemas()` schemas as the modules' `schemas` rather than each table's `schema`.

## Found in Phase 5B (resilience: reconnect, resubscribe, stale data)

See [resilience.md](resilience.md) for the behaviour these work around.

81. **vuu-ui RPC / menu requests never time out, and a send while disconnected is dropped.** (finos
    `@vuu-ui/vuu-data-remote` `ConnectionManager.asyncRequest` / `ServerProxy`, 4.0.0-alpha.21.) The pending request
    is kept until a response arrives. If the socket drops after the send, or the send happens while disconnected
    (the worker discards it), the promise never settles, so a menu action or order RPC spins forever. Rejecting
    pending requests on `disconnected` (and refusing sends while not connected), plus an optional per-request
    timeout, would fix it. *Workaround:* `sendTradingRpc` / the edit-session amend take `connectionState` (fail at
    once, nothing sent) and a `timeoutMs` (default 10 s) and reject with `TradingRpcError.transport`
    `"disconnected"` / `"timeout"`.
82. **`WebSocketConnection` never reports `connecting` or `reconnecting`.** (finos `@vuu-ui/vuu-data-remote`,
    4.0.0-alpha.21.) The `connectionStatus` setter ignores those two values, so listeners only see
    `websocket-open`, `connected` / `reconnected`, `disconnected` and `closed`, and cannot tell "down, retrying"
    from "down for good". Emitting them would fix it. *Workaround:* trader keeps the reconnect state itself
    (`connectionStateStore`, fed by the registry and `ReconnectSupervisor`) and combines it with the socket status
    in `useTradingConnectionStatus`.
83. **A login refused with an unrecognised text frame hangs the connect for good.** (vuu-websocket
    `@heswell/vuu-server` 4.2 and finos `@vuu-ui/vuu-data-remote` 4.0.0-alpha.21.) At the session limit the server
    answers LOGIN with the text `maximum sessions (N) reached for user X` (also `Invalid session <id>`) and closes
    with 4003. `isLoginErrorMessage` / `InvalidLoginMessages` do not match it, so `receive` passes it to
    `parseWebSocketMessage`, which throws "Error parsing JSON response"; `onclose` then sets `disconnected`, but the
    deferred open has already resolved and the pending login is never rejected, so
    `ConnectionManager.connectWithLoginResponseTo` never settles and `VuuConnectionRegistry`'s connect / reconnect
    loop stops waiting on it. Related to trader upstream issue 74. Fix in vuu-server (heswell/vuu-websocket): answer
    a refused LOGIN with a JSON `LOGIN_FAIL` message (`{ type: "LOGIN_FAIL", msg: "maximum sessions (N) reached",
    code: 4003 }`) before closing, or use a text vuu-ui's `InvalidLoginMessages` recognises. Fix in vuu-ui: reject the
    pending login when the socket closes before LOGIN_SUCCESS, and treat an unparseable frame during login as a
    refusal. *Workaround:* `createResilientConnectionRegistry` fails an attempt when the socket closes after opening
    and before LOGIN_SUCCESS, and after `loginTimeoutMs` (20 s) at most.
84. **`VuuConnectionRegistry` does not retry a failed first connect, and gives up on reconnects after ~4 minutes.**
    (finos `@vuu-ui/core`, 4.0.0-alpha.21.) `acquire` sets `failed` and rejects when the first connect fails
    (server down, login refused at the session limit), and `RemoteModule` shows its error boundary ("An error
    occurred while creating the remote module"). After a drop it retries on `retryIntervals` (1–120 s, no jitter, so
    every tab retries in lock-step), then stops for good. A retry policy shared by first connects and reconnects,
    with jitter and an option never to give up, and the attempt number / next attempt time in the state events,
    would fix it. *Workaround:* `createResilientConnectionRegistry` passes a jittered, unbounded `retryIntervals`
    iterable and wraps `acquire` to retry first connects with the same backoff (one shared wait per connection id,
    403 not retried), publishing the next attempt time.
85. **`PortalHeader` has no slot for status items.** (finos `@vuu-ui/core` portal, 4.0.0-alpha.21.) A host cannot put
    a connection indicator (or anything else) in the header. A `children` / `endAdornment` slot would fix it.
    *Workaround:* the portal host renders `ConnectionStatusIndicator` after `PortalHeader` and positions it over the
    header with CSS (`apps/portal-host/src/App.css`).
86. **`WebSocketConnection.openWebSocket`'s timeout throws inside `setTimeout`.** (finos `@vuu-ui/vuu-data-remote`,
    4.0.0-alpha.21.) When the socket does not open in time the timer throws `Failed to open WebSocket connection to
    …`, an uncaught error in the worker, instead of rejecting the open promise, so the caller waits forever and the
    socket is not closed. Rejecting the deferred open (and closing the socket) would fix it. *Workaround:* the
    per-attempt login timeout of trader upstream issue 83.
87. **`useDataSource` throws if its effect re-runs while the viewport is still subscribing.** (finos
    `@vuu-ui/vuu-table` `useDataSource`, 4.0.0-alpha.21.) The effect treats any status other than `initialising` /
    `unsubscribed` as resumed and throws "[useDataSource] a resumed dataSource must have a tableSchema" when there is
    no schema yet. It re-runs whenever a dependency changes, including the `Table`'s `onSelect`, so a callback
    rebuilt during a cold start or a resubscribe after a reconnect (e.g. when the instrument lookup loads) breaks
    the whole module. Treating `subscribing` like `initialising` (wait for the schema) would fix it. *Workaround:*
    trader's Tables get a stable `onSelect` (`useStableCallback`).
88. **`ServerProxy` clears every viewport on disconnect.** (finos `@vuu-ui/vuu-data-remote`, 4.0.0-alpha.21.) On
    `disconnected` the worker clears all viewports' rows, so a grid, ladder or depth book goes empty while the server
    is down instead of keeping the last data greyed out as stale; it repopulates after the resubscribe. An option to
    keep rows until the resubscribe (and send the size / rows fresh then) would fix it. *Workaround:* none; views
    are marked stale while down and empty until they repopulate.
89. **`ConnectionManager.destroyConnection(id)` drops every status listener of the id.** (finos
    `@vuu-ui/vuu-data-remote`, 4.0.0-alpha.21.) It deletes the id's whole listener set, including listeners
    registered by others (status hooks), so after a failed connection is destroyed and a new one is made for the
    same id they never hear from it. Removing only the destroyed connection's own wiring would fix it.
    *Workaround:* `useVuuConnectionStatuses` re-reads and re-subscribes whenever the registry state of an id
    changes.

## Found in Phase 5A (performance)

90. **`TableHeader`'s `memo` is defeated on data updates.** (finos `@vuu-ui/vuu-table`, 4.0.0-alpha.21.) `Table`
    passes `TableHeader` callbacks from `useTable` whose identity changes as rows update: `onMoveColumn` (its
    dependencies include `focusCell`, which depends on `requestScroll` in `useCellFocus`) and
    `onCheckBoxColumnHeaderClick` (from `useSelection`, rebuilt when its `onSelectionChange` changes). In the
    showcase trader workspace the headers re-render about 9 times a second, and the column-header menus
    (`MenuBase` / `ColumnMenu`) cost 8–15 ms/s of scripting per table under a 4× CPU throttle
    (docs/performance.md). Keeping these callbacks stable (refs for the changing values) would fix it.
    *Workaround:* none in trader.
91. **vuu-server exposes no metrics.** (vuu-websocket `@heswell/vuu-server` 4.2.0.) There is no API for
    per-session queue depth, rows sent and coalesced, send-cycle duration or viewport counts, so throughput and
    coalescing can only be estimated from the outside. A metrics hook or periodic stats event would fix it.
    *Workaround:* `PerfStatsReporter` (`packages/oms/src/perf`, enabled by `TRADER_PERF_STATS_FILE`) counts
    trader's own table writes, CPU, memory and event-loop lag; `perf:ws` derives server→client coalescing from
    those and the client-received rows.
92. **The session send cycle is fixed at 60 ms / 300 rows.** (vuu-websocket `@heswell/vuu-server` 4.2.0.) The
    session runner is a `LifeCycleRunner` with a hard-coded 60 ms minimum cycle, and both flow controllers return
    `BatchSize(300)`. Neither can be configured, so end-to-end latency has a floor of about 30 ms on average
    (p50 36 ms in the smoke run), and a burst of more than 300 changed rows per session waits extra cycles.
    Conf keys for the cycle time and batch size would fix it. *Workaround:* none; the baselines in
    docs/performance.md include it.

## Found in Phase 5C (persistence: order state survives a restart)

See [persistence.md](persistence.md).

93. **hft-limit-order-book's snapshot types are not exported, and a snapshot drops the market price and trade
    count.** (`@heswell/hft-limit-order-book` 2.0.0.) `OrderBook.snapshot()` returns `Snapshot` and the
    `OrderBookOptions.snapshot` constructor option takes one, but the package entry exports neither `Snapshot` nor
    `ILimitOrder` / `IStopOrder`, so a caller that stores and filters a snapshot has to derive them from
    `OrderBookOptions`. The snapshot also omits the private `_marketPrice` (last trade price, used by stop orders)
    and `_tradeCount`, so a book restored from it starts with `marketPrice` 0 and its trade count at 0. Exporting
    the types and adding `marketPrice` / `tradeCount` to `Snapshot` (restored by the constructor) would fix it.
    *Workaround:* `exchange-sim/src/engine/persistence.ts` derives `BookSnapshot` / `ILimitOrder` from
    `OrderBookOptions["snapshot"]`; the simulator keeps its own trade-id counter (journaled in blocks) and fair
    value, and uses no stop orders, so the missing market price has no effect today.
