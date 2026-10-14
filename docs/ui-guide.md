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
    This rule replaces the `trd` prefix in the original plan. Every component uses `trading<Name>`; there are no
    `trd*` classes.
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

**Component docs.** Market depth and the price ladder, plus their shared market-data hooks (`useMarketDepth`, `useOwnWorkingOrders`, …), are documented in [components/market-depth-and-ladder.md](components/market-depth-and-ladder.md).

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

## 5. Instrument linking (P3.11)

Components follow and publish the selected instrument through **link groups** (channels), like the coloured link
groups of Bloomberg / Eikon. They never talk to each other directly. Each component instance joins one group:
`red`, `green`, `blue`, `yellow` (`DEFAULT_LINK_GROUPS`) or `unlinked` (a private selection). Selecting a ric in a
source (grid, blotters, positions, picker) publishes it to the group; followers in the group (ticket, depth,
ladder, tape, grid highlight) follow it. Visual links are a different thing: they are one-way parent→child server
filters between Tables, and stay as they are. Link groups sit beside them.

```ts
interface SelectedInstrument {
  ric: string;
  description?: string; currency?: string; exchange?: string;
  tickSize?: number; tickBands?: string; lotSize?: number; priceDecimals?: number;
}
// Unchanged API; resolves to the component's group (default: inherited, else "red").
const { selectedInstrument, selectionSource, setSelectedInstrument, linkGroup } =
  useSelectedInstrument({ linkGroup: channel });
```

**Layers.**

- `instrumentLinkBus.ts`: a framework-free store with `publish(group, instrument, source)`, `subscribe(group, fn)`,
  `subscribeAll`, `getSelection`, `receive`, `snapshot` and `addTransport`. `getInstrumentLinkBus()` returns the one
  bus per window. It lives on `globalThis` under `Symbol.for("@heswell/trading-ui/instrument-link-bus/v1")`, so
  separately mounted MF features share it even when they do not share a React tree or a copy of trading-ui.
- `connectBroadcastChannel(bus)` (optional) links windows / popouts of the same origin. Selections carry a Lamport
  `seq` and an `origin`, and are applied last-writer-wins. Received selections are never re-posted (no loops). A new
  window asks for the current selections. Private groups never leave the window.
- React: `useSelectedInstrument()` reads and writes the bus. It works without any provider (the window bus).
  `InstrumentContextProvider` is now optional. It gives a subtree a private bus (tests, previews), or `bus={…}`,
  and a default group. `LinkGroupProvider linkGroup="green"` sets the default group of a subtree (e.g. a whole MF
  feature).
- Components: every linkable component accepts `LinkGroupProps` (`linkGroup`, `defaultLinkGroup`,
  `onLinkGroupChange`, `showLinkGroupSelector`) and calls `useComponentLinkGroup()`. That returns
  `{ linkGroup, channel, setLinkGroup }`; pass `channel` to `useSelectedInstrument`. `channel` is
  `unlinked:<useId>` for an unlinked instance. `<LinkGroupSelector value onChange />` is the compact header control
  (swatch plus name, so it does not rely on colour alone). It is off by default (`showLinkGroupSelector`).

**Rules.**

- **Source tagging.** Pass a stable `source` id. The bus drops a publish of the ric a group already has (unless it
  adds static data), so a follower that echoes a selection back changes nothing. Ignore your own echoes with
  `selectionSource === myId` when a follow would re-trigger your own publish.
- **Unknown rics.** `publish` rejects a missing or blank ric and strips non-instrument fields.
  `setSelectedInstrument` enriches a bare ric from the `InstrumentLookup` when it knows it. Followers must render
  sensibly with an unknown ric or none: the grid clears its selection, and depth / ladder show an empty book.
- **Publish static data** when you have it (instrumentPrices rows carry all the fields), so consumers can format
  and validate without another lookup.
- **Persistence.** The group the user picks is saved with the layout. Inside a vuu-layout `View` it is saved in the
  View's state (`save(group, "linkGroup")`) and returned by `load("linkGroup")`, so it travels in the layout JSON
  (the Trader workspace example restores it after a reload). Outside a View, with a `persistKey`, it goes to vuu-portal
  `usePersistedState()` under `trading.linkGroup.<persistKey>`. The order of precedence is: `linkGroup` prop, then
  saved, then `defaultLinkGroup`, then inherited.

**MF features (Phase 4).** In each feature's `portal-build.json` `shared` block, add `@heswell/trading-ui`,
`react`, `react-dom` and `@vuu-ui/vuu-layout` as **singletons**. trading-ui keeps the React context and the
InstrumentLookup in one copy. vuu-layout keeps View state in a module-level map (`setPersistentState`), so every
feature must use the host's copy for the saved group to be found. The bus itself still links features that end up
with their own copy, through `globalThis`, provided they use the same bus protocol version
(`INSTRUMENT_LINK_BUS_VERSION`). The host calls `connectBroadcastChannel(getInstrumentLinkBus())` once if popouts
should link. A feature that wants its own group by default wraps itself in `LinkGroupProvider`.

## 6. Test data (`@heswell/trading-test-data`)

The real `exchange-sim` and `oms` engines run in the browser on `@heswell/vuu-data-engine-local`. Schemas, RPCs,
reject reasons, edit sessions, visual links and permissions behave like the server. See its README for the API.

- Showcase/app: `createTradingLocalServer()` creates a singleton with ticking timers that start on the first
  subscription, 50 active instruments and OMS background flow. Open the showcase with `?active=200` to simulate 200.
- Deterministic tests: `createTradingTestData({ seed: 1, manualClock: true, oms: { flowRate: 0 } })`, then
  `td.advance(2_000)` to build the books. Call `td.dispose()` in `afterEach`.
- `setCurrentUser({ name, authorizations: [] })` controls OMS account visibility. `admin` sees all accounts; alice
  sees only ACC-US-01. Market orders fill synchronously (gateway latency 0).

## 7. Showcase

`bun run dev:showcase` serves http://localhost:5001 on local data. "Remote server" connects directly (CORS) to the
standalone trading server: `bun run dev:trading-server` (EXCHANGE + OMS, permissive auth over plain http/ws,
:8095/:8447). Override the target with `TRADING_REMOTE_WS` and `TRADING_REMOTE_AUTH`. The `bun run dev` portal server uses Keycloak, so it is reached through vuu-portal and not
through the showcase.

**Adding an example.**

1. Create `apps/showcase/src/examples/<ComponentName>Examples.tsx` and export one component per example. Examples
   use `@heswell/trading-ui` hooks only, so they work on both data modes. Do not import test data.
2. Register it in `apps/showcase/src/examples/index.ts`:
   ```ts
   { id: "price-ladder-basic", group: "PriceLadder", title: "Basic", description: "…", Component: PriceLadderBasic },
   ```
   `id` is unique and url-safe, and becomes `#price-ladder-basic`. `group` is the component name.
3. The app wraps every example in `TradingDataProvider` (local or remote) and `ShowcaseTradingHost`, inside
   `SaltProviderNext` with vuu-theme. Examples share the window-wide link bus (connected to a BroadcastChannel). The
   header shows each group's ric. Use the trading-ui `InstrumentPicker` / `InstrumentGrid` to select instruments
   (`examples/shared/InstrumentSelector.tsx` adds halt / resume). The examples area fills its height, so give tables a sized flex container.

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

## 10. Packaging a component as an MF feature (`apps/features/trading`)

All features live in one package, `apps/features/trading`, and are built as one MF remote each (the portal needs a
unique `mfScope` per module, upstream #45). See [portal-integration.md](portal-integration.md) for the architecture,
the roles and the run-all command.

1. Add `src/features/<Name>.tsx`. It renders trading-ui components wrapped in `withFeatureRoot` /
   `TradingFeatureRoot`, which mounts notifications (toasted once per window), the ticket launcher and the
   connection banner. Do not add a `TradingDataProvider`: data access is `mode="inherit"`, so the connection
   `RemoteModule` provides is used. That is the trading server, named in the remote's `config.json`, which
   `bun run build` writes for every feature.
2. Give components stable `id`s. They key the saved state (e.g. `trading.linkGroup.<id>` in the module's portal
   state).
3. Add an entry to `src/catalog.ts`: a unique `key`, module `id`, `mfScope`, `accessRole` (the `vuu-portal` nav role
   for `trading-view`, `trading-execute` or `trading-supervisor`, via `TRADING_ACCESS_ROLE`), and either `location` + `path` (nav entry) or `parent` (child module
   rendered by another feature through `usePortalModuleRegistry()` + `RemoteModule`).
4. Run `bun run features:sync`. This regenerates `portal-build.json` (one remote per entry, the shared block and
   `cssInline`, upstream #23) and `apps/portal-config/default-modules.yaml`. Then run `bun run build`, which renames
   each remote's chunk global (upstream #44). `bun run features:check` (CI) fails on drift.
5. Shared singletons are react, react-dom, react-router-dom, `@vuu-ui/core` (+ `/portal`), vuu-data-remote,
   vuu-notifications, `@salt-ds/core` and `@heswell/trading-ui`, so instrument linking works across features
   through the one window bus. **`@vuu-ui/vuu-layout` is not shared**: sharing it deadlocks startup (upstream
   #43), so View state from a remote is not visible to trading-ui (upstream #50) and components fall back to portal
   state (§5).

## 11. Shared renderers and hooks (P3.7–P3.10)

Grids that need status, side, progress, price, P&L, time or liquidity cells should use the registered renderers
in `TradingRenderer` (`registerTradingCellRenderers()`; call it at module level because `sideEffects` only lists
CSS) rather than writing new ones. Non-Table views (e.g. the tape) use `useDataSourceRows` for rAF-coalesced
rows (see §12, "Rows as objects"). See `packages/trading-ui/README.md` for the component props and `docs/upstream-issues.md` #28–32 for the
alpha.20/alpha.21 constraints behind the design choices.

## 12. Order ticket, notifications and connection state (P3.6, P3.12)

- **Opening a ticket.** Any component can open the order ticket with
  `useOrderTicketLauncher().openOrderTicket({ ric, side, price, quantity })` (see the
  [OrderTicket README](../packages/trading-ui/src/components/OrderTicket/README.md)). Do not build your own ticket.
  For an inline ticket, render `<OrderTicket variant="compact" prefill={…} />`.
- **Toasts.** Order toasts come from `TradingNotificationsProvider`, which watches `parentOrders` and `fills`, so
  components do not toast their own orders. Use `useTradingNotifications().notify(event)` only for failures that
  never reach the OMS. See the [notifications README](../packages/trading-ui/src/notifications/README.md).
- **Mounting.** The host mounts `TradingNotificationsProvider`, `OrderTicketLauncherProvider` and
  `ConnectionBanner` once (the showcase does this in `ShowcaseTradingHost.tsx`).
- **Staleness.** Components that show live prices can use `useStaleIndicator({ lastUpdate })` or
  `<StaleIndicator lastUpdate={…} />`.
- **Rows as objects.** There is one primitive, in `data/useDataSourceRows.ts`:
  - `subscribeTradingRows(dataSource, { rowCount | range, filter?, groupBy?, aggregations? }, listener)` is
    framework-free. Every viewport message calls `listener({ rows, updated, size, messageSize, loaded, cleared })`.
    It returns unsubscribe.
  - `useDataSourceRows(dataSource, { …config, enabled?, throttle? })` returns `{ rows, size, loaded, version }`
    for a data source you own. It renders at most once per animation frame (`throttle: "none"` renders every
    message). It re-subscribes with the rows cleared when the filter / grouping / range change.
  - `useTradingRows(table, { filter, rowCount, … })` creates the data source too and returns
    `{ dataSource, rows, size, loaded }`. An undefined filter means no filter.

  Rows are `TradingRow` objects (`{ column: value, $key, $index, $isLeaf, $depth }`). They suit a small or
  custom-rendered row set (a quote, the account list, the tape, the depth book). Use a vuu `Table` for grids.
- **Default wiring.** Inside an `OrderTicketLauncherProvider`, InstrumentGrid Buy / Sell open the ticket (pass
  `onBuy` / `onSell`, or `launchOrderTicket={false}`, to override). Inside a `TradingNotificationsProvider`,
  PriceLadder and OrderBlotter RPC failures and ladder acks go to `notify` (`notify={false}` to opt out).
  `orderEventKey` dedupes them against the stream toasts. Toast prices use the instrument's decimals / tick size
  from the InstrumentLookup.

