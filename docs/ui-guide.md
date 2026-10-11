# UI guide (Phase 3)

Conventions for every trading UI component. The goal is a **reusable** front end: the same components run in the
showcase on local test data, against a standalone Vuu server, and as module-federation (MF) features inside
vuu-portal.

```
packages/
  trading-schemas/     table defs, enums, RPC contracts, tick/lot utils (no React)
  trading-test-data/   in-browser EXCHANGE + OMS (the real exchange-sim + oms engines), for the showcase and tests
  trading-ui/          React components, data hooks, instrument context, formatters  <- components go here
apps/
  showcase/            rsbuild dev app: component examples, local/remote toggle
  features/<name>/     MF remotes for vuu-portal (thin wrappers around trading-ui components)
```

## 1. Where components go and naming

- One folder per component: `packages/trading-ui/src/components/<ComponentName>/`. It contains:
  - `<ComponentName>.tsx`
  - `<ComponentName>.css`
  - optional hooks (`use<ComponentName>.ts`) and sub-components
  - `index.ts` (`export * from "./<ComponentName>"`)
- Export the folder from `packages/trading-ui/src/index.ts`. Consumers import only from `@heswell/trading-ui`, never
  deep paths.
- Naming:
  - Components and types use PascalCase (`PriceLadder`, `PriceLadderProps`). Hooks use `useX`. Pure helpers live in
    `src/utils/`.
  - CSS class base: `trading<ComponentName>` (camelCase). Elements and modifiers are `-suffix`, e.g. `tradingPriceLadder`,
    `tradingPriceLadder-row`, `tradingPriceLadder-bid`. This mirrors vuu-ui (`vuuTable`, `vuuTableRow-selected`).
  - Component CSS custom properties: `--tradingPriceLadder-rowHeight`. Shared semantic tokens are `--trading-*`
    (see §3).
  - `testId` for CSS injection: kebab-case, `trading-price-ladder`.
- Component conventions:
  - Use `forwardRef`, and spread the remaining HTML attributes onto the root element.
  - Accept `className`.
  - Add `data-*` attributes for state that tests and CSS select on (`data-side`, `data-status`).
- Props:
  - Controlled where it matters (`value`/`onChange`), with optional uncontrolled defaults.
  - Callbacks are named `on<Event>`.
  - No data fetching in leaf presentational components (see §4).

## 2. Styling: CSS injection and Salt / Vuu theming

We follow vuu-ui's approach. Each component imports its stylesheet as a string and injects it at runtime:

```tsx
import { useComponentCssInjection } from "@salt-ds/styles";
import { useWindow } from "@salt-ds/window";
import priceLadderCss from "./PriceLadder.css";

const classBase = "tradingPriceLadder";

export const PriceLadder = forwardRef<HTMLDivElement, PriceLadderProps>(function PriceLadder(props, ref) {
  const targetWindow = useWindow();
  useComponentCssInjection({ testId: "trading-price-ladder", css: priceLadderCss, window: targetWindow });
  ...
});
```

Why: MF features and pop-out windows (`@salt-ds/window`) get their CSS with the component, and there is no global
stylesheet to load. The same `.css` source works in every environment:

| Environment | How `import css from "./X.css"` becomes a string |
| --- | --- |
| showcase | `apps/showcase/css-inline-loader.cjs` rewrites to `./X.css?inline` (rsbuild returns the text) |
| MF feature | portal-build `cssInline` option (see §8) |
| `bun test` | a `*.css` loader plugin in `scripts/dom-test-setup.ts` |
| typecheck | `packages/trading-ui/src/css.d.ts` (`declare module "*.css"` -> `string`) |

Rules:

- **Use Salt / vuu-theme tokens only**, never literal colours or sizes. For example:
  - `--salt-spacing-100`
  - `--salt-size-border`
  - `--salt-content-primary-foreground`
  - `--salt-sentiment-positive-foreground-informative`
  - `--salt-status-error-foreground-informative`
  - `--salt-text-fontWeight-strong`

  The theme is `vuu-theme` via `SaltProviderNext theme="vuu-theme" density="high"`. The showcase sets it up;
  vuu-portal provides it for features.
- Do not import global CSS from components. App-level CSS (`import "./App.css"`) is fine in the showcase and features.
- Density and mode come from Salt. Do not hard-code row heights: use `--salt-size-base` or the
  `--tradingX-rowHeight` custom properties.
- Inside vuu Tables, prefer column `type.renderer` (for example `vuu.price-move-background`, which needs a side-effect
  `import "@vuu-ui/vuu-table-extras"` in the app) or register a renderer with vuu-utils'
  `registerComponent(name, Component, "cell-renderer", ...)`. Do not post-process DOM.

## 3. Shared utilities (`@heswell/trading-ui`)

**Formatting.** All formatters return `""` for non-numbers.

| Function | Result |
| --- | --- |
| `formatPrice(price, { priceDecimals?, tickSize?, tickBands? })` | Decimals follow `priceDecimals`, otherwise the tick at that price (tick bands supported). You can pass a `SelectedInstrument` directly: `formatPrice(p, selectedInstrument)`. |
| `priceDecimals(price, format)` | The decimals only, e.g. for vuu column `formatting.decimals`. |
| `formatQuantity(q, { compact? })` | `1,234,567` or `1.2M` |
| `formatNotional(amount, { currency?, signed?, compact? })` | `+1,234.50 USD` |
| `formatPercent(value, decimals = 2)` | Signed, e.g. `+1.25%` (the value is already ×100, like `changePct`) |

Tick and lot maths (rounding, validation, ladder steps) live in `@heswell/trading-schemas`: `tickSizeAt`, `roundToTick`, `stepTicks`, `ticksBetween`, `isOnTick`, `isValidLot`,
`roundToLot`, `tickScheduleOf`. Do not reimplement them.

**Colours.** CSS var strings with Salt fallbacks, so they theme automatically and apps can override them.

- `TradingColour.{buy, sell, up, down, neutral, pending, working, filled, rejected, done}`, e.g.
  `var(--trading-buy, var(--salt-sentiment-positive-foreground-informative))`.
- `sideColour(side)`, `directionColour(value)`, `orderStatusCategory(status)`, `orderStatusColour(status)` and
  `tradingPhaseColour(phase)`.
- In CSS, use the same `var(--trading-buy, …)` chain (see `SideLabel.css`).

**Example component.** `SideLabel` is the reference implementation of these conventions: folder, CSS injection,
tokens, `data-side`, `forwardRef`, and a test.

## 4. Data access: remote vs local

Components never construct data sources from a specific implementation. They get them from the nearest data
provider, so the host decides where data comes from:

```tsx
const dataSource = useTradingDataSource("parentOrders", {
  columns, sort, filterSpec, // optional initial config; columns default to all schema columns
});
return <Table config={config} dataSource={dataSource} />;
```

- `useTradingDataSource(table, options?)` resolves the module (EXCHANGE or OMS) from trading-schemas. It creates the
  data source once per table and provider, using `useData().VuuDataSource` from `@vuu-ui/core`, and unsubscribes on
  unmount. Options are initial only: change `ds.filter`, `ds.sort` and so on afterwards, or let a Table drive them.
- `tradingTableSchema(table)`, `tradingVuuTable(table)` and `tradingColumnNames(table)` give static schema access.
  This is the same `TableSchema` the server sends.
- **RPCs:**
  - `sendTradingRpc(dataSource, "createOrder" | "amendOrder" | "cancelOrder" | "cancelAll" | admin RPCs, params)`
    is typed by the trading-schemas contracts and resolves with the response data.
  - On failure it rejects with `TradingRpcError { reason, text }`, where `reason` is a `RejectReason` such as
    `PRICE_OUTSIDE_COLLAR`.
  - Send order RPCs through an OMS-table data source, and admin RPCs through an EXCHANGE one. The data source must
    be subscribed (for example rendered by a Table, or call `subscribe`).
- **Editing.** Amend through a parentOrders edit session (`ds.beginEditSession()` → `editCell` → `endEditSession`).
  Only `quantity` and `price` can be edited, or use `amendOrder`.
- **Visual links.**
  - Declared in trading-schemas (for example depth → instrumentPrices by `ric`), and served identically by local and
    remote.
  - Use `ds.links` / `ds.visualLink`, or a vuu Table's "Link to …" menu.
  - Cross-feature instrument following uses the instrument context (§5).

`TradingDataProvider` chooses the implementation:

| mode | Use | What it does |
| --- | --- | --- |
| `inherit` (default without a provider) | **MF features inside vuu-portal**, or any host with a `@vuu-ui/core` `DataProvider` | Uses the host's data provider (the portal's authenticated connection). |
| `local` + `localServer` | showcase, tests, demos | An in-browser `LocalVuuServer`, e.g. `createTradingLocalServer()` from `@heswell/trading-test-data`. |
| `remote` + `connectionId` | showcase "Remote server", standalone apps | `VuuDataSource` bound to a connection opened with `connectToVuuServer({ connectionId, websocketUrl, authUrl, username, password })`. |

`useTradingDataMode()` returns `{ mode, connectionId }`. `useHasDataProvider()` tells you whether any provider is
present.

**Never import `@heswell/trading-test-data` from `packages/trading-ui/src` or from features.** It bundles both
engines and is a devDependency of trading-ui, for tests only.

## 5. Instrument context (P3.11 placeholder)

Components follow, and publish, the selected instrument through a context. They never talk to each other
directly:

```ts
interface SelectedInstrument {
  ric: string;
  description?: string; currency?: string; exchange?: string;
  tickSize?: number; tickBands?: string; lotSize?: number; priceDecimals?: number;
}
interface InstrumentContextValue {
  selectedInstrument: SelectedInstrument | undefined;
  selectionSource: string | undefined;           // id of the component that selected
  setSelectedInstrument(instrument: SelectedInstrument | undefined, source?: string): void;
}
const { selectedInstrument, setSelectedInstrument } = useSelectedInstrument();
```

- Publish as much static data as you have, so consumers (the ticket, the ladder) can format and validate without
  another lookup. instrumentPrices rows carry all the fields.
- Pass a stable `source` id. Ignore your own echoes with `selectionSource === myId`.
- `useSelectedInstrument()` works without a provider: the selection is always `undefined` and setting it is a no-op.
  Components must render sensibly with no selection.
- `InstrumentContextProvider` (`initialInstrument`, `onSelectionChange`) is a local React-state placeholder. P3.11
  will back the same interface with a bus shared across MF features and windows (link groups/channels). Code
  against the hook and the interface, not the provider.

## 6. Test data (`@heswell/trading-test-data`)

The real `exchange-sim` and `oms` engines run in the browser on `@heswell/vuu-data-engine-local`. Schemas, RPCs,
reject reasons, edit sessions, visual links and permissions behave like the server. See its README for the API.

- Showcase/app: `createTradingLocalServer()` creates a singleton with ticking timers that start on the first
  subscription, 50 active instruments and OMS background flow.
- Deterministic tests: `createTradingTestData({ seed: 1, manualClock: true, oms: { flowRate: 0 } })`, then
  `td.advance(2_000)` to build the books. Call `td.dispose()` in `afterEach`.
- `setCurrentUser({ name, authorizations: [] })` controls OMS account visibility. `admin` sees all accounts; alice
  sees only ACC-US-01. Market orders fill synchronously (gateway latency 0).
- Bundlers must map `node:crypto` to `@heswell/trading-test-data/shims/node-crypto`. In rspack, use
  `NormalModuleReplacementPlugin`, because a resolve alias does not apply to `node:` URIs; see
  `apps/showcase/rsbuild.config.ts`.

## 7. Showcase

`bun run dev:showcase` serves http://localhost:5001 on local data. "Remote server" connects through the dev-server
proxy (`/remote/trading/*`) to the standalone trading server: `bun run dev:trading-server` (EXCHANGE + OMS,
permissive auth, :8095/:8447). Override the target with `TRADING_REMOTE_WS`, `TRADING_REMOTE_WS_PATH` and
`TRADING_REMOTE_AUTH`. The `bun run dev` portal server uses Keycloak, so it is reached through vuu-portal and not
through the showcase.

**Adding an example.**

1. Create `apps/showcase/src/examples/<ComponentName>Examples.tsx` and export one component per example. Examples
   use `@heswell/trading-ui` hooks only, so they work on both data modes. Do not import test data.
2. Register it in `apps/showcase/src/examples/index.ts`:
   ```ts
   { id: "price-ladder-basic", group: "PriceLadder", title: "Basic", description: "…", Component: PriceLadderBasic },
   ```
   `id` is unique and url-safe, and becomes `#price-ladder-basic`. `group` is the component name.
3. The app wraps every example in `TradingDataProvider` (local or remote) and `InstrumentContextProvider`, inside
   `SaltProviderNext` with vuu-theme. The examples area fills its height, so give tables a sized flex container.

To avoid merge conflicts between parallel sessions, keep each session's examples in its own file and add only one
registry line per example.

## 8. Testing

- `bun run test` runs `test:server` (schemas, exchange-sim, oms; no DOM) and `test:ui` (trading-test-data and
  trading-ui, with `--preload ./scripts/dom-test-setup.ts`: happy-dom globals and the `*.css` loader). CI runs
  `bun run test`.
- Put tests in `packages/trading-ui/__tests__/<Name>.test.tsx`, using `bun:test` and `@testing-library/react`
  (`render`, `screen`, `act`, `waitFor`; `afterEach(cleanup)`). Prefer role, label or text queries plus `data-*`
  attributes.
- Data-bound components: render inside `<TradingDataProvider mode="local" localServer={createTradingLocalServer(td, "<unique-id>")}>`
  with a seeded, manual-clock `td` (see `__tests__/useTradingDataSource.test.tsx`). Advance the clock to drive
  ticks.
- happy-dom has no layout, so vuu `Table` virtualisation renders few or no rows in tests. Test hooks and logic at
  the data-source level, and keep visual checks for the showcase. If a new test directory is added, append it to
  `test:ui` in the root `package.json` (bun errors on paths with no tests).
- Every component needs at least one test covering rendering, a11y attributes and its main interaction.

## 9. Accessibility and keyboard

- Use Salt components (Button, ToggleButtonGroup, Input, Dropdown, FormField) where possible. They handle focus,
  roles and density.
- Grids are vuu `Table`s, which provide keyboard navigation (arrows, Home/End, PageUp/Down) and `aria-rowcount`.
  Custom grids, such as the ladder, use `role="grid"` with roving `tabIndex` and arrow-key navigation.
- Do not convey buy/sell or up/down by colour alone. Use text, arrows or `aria-label`, for example SideLabel's text.
- Live values that matter (order status, rejections) go in `role="status" aria-live="polite"`. Errors use
  `role="alert"`.
- Global shortcuts must be scoped to the component's focus-within, never `window`, because several features share
  one page in the portal.

## 10. Packaging a component as an MF feature (`apps/features/<name>`)

Copy `apps/features/hello` (rsbuild via `@vuu-ui/portal-build`):

1. `package.json`: name it `@heswell/trading-feature-<name>`. Depend on `@heswell/trading-ui`, plus `@vuu-ui/*`,
   `@salt-ds/core` and react as peers. Use a `build` script (`portal-build --config ./portal-build.json`), a unique
   port (5011+) and `publicPath`.
2. `src/<Feature>.tsx` renders the trading-ui component. Do not wrap it in a `TradingDataProvider`, or wrap it in
   `mode="inherit"`: the portal host provides the authenticated `DataProvider`.
3. In `portal-build.json`:
   - `moduleFederation.name` must be unique, e.g. `tradingBlotter`. `exposes` the component.
   - Keep the `shared` block from hello: `@vuu-ui/core` and `@vuu-ui/core/portal` are singletons, so `useData()`
     resolves the host's provider.
   - Add `"cssInline": { "include": ["/packages/trading-ui/", "/apps/features/"] }`, because the default list only
     covers vuu packages (upstream #23).
4. Register it in `apps/portal-config/default-modules.yaml`: `mfScope` must equal `moduleFederation.name`, and
   `mfComponent` is the exposed name. Add it to `scripts/dev.ts` if it should start with `bun run dev`.
5. The instrument context in the portal is P3.11's job. Until then each feature has an independent selection.

## 11. Shared renderers and hooks (P3.7–P3.10)

Grids that need status, side, progress, price, P&L, time or liquidity cells should use the registered renderers
in `TradingRenderer` (`registerTradingCellRenderers()`; call it at module level because `sideEffects` only lists
CSS) rather than writing new ones. Non-Table views (e.g. the tape) use `useDataSourceRecords` for rAF-coalesced
rows. See `packages/trading-ui/README.md` for the component props and `docs/upstream-issues.md` #28–32 for the
alpha.20 constraints behind the design choices.
