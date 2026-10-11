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
