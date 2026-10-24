# Trading UI components

`@heswell/trading-ui` is the reusable front end: React components, hooks and host services built on vuu-ui
(`@vuu-ui/*` 4.0.0-alpha.25) and Salt. The same component runs inside vuu-portal, against a stand-alone Vuu server
or on in-browser data (see [hosting.md](hosting.md) and [getting-started.md](../getting-started.md)).

- **Guides** (this folder, hand-written): what each component is for, how to compose it, data, RPCs, roles and CSS.
- **API reference** ([../api/](../api/README.md), generated from the TypeScript source and its JSDoc by
  `bun run docs:api`): every export with its props, types and defaults.
- **Catalogue** ([../api/components.md](../api/components.md), generated): per component, the tables it subscribes
  to, the RPCs it calls, its CSS hooks and its showcase examples.
- **Showcase** (`bun run dev:showcase`, [apps/showcase](../../apps/showcase/README.md)): a live example of every
  component on local data; each example links back here.

## Guides

| Guide | Components | Showcase |
| --- | --- | --- |
| [hosting.md](hosting.md) | `TradingDataProvider`, `TradingFeatureRoot`, `OrderTicketLauncherProvider`, `UserSettingsProvider`, `TradingConnectionStateOverride` | `#hosting-*` |
| [instrument-grid.md](instrument-grid.md) | `InstrumentGrid`, `Sparkline` / `SparklineCell`, `PriceMoveCell`, `ChangeCell`, `QuantityCell`, `PhaseCell` | `#instrument-grid*`, `#primitives-cell-renderers` |
| [blotters.md](blotters.md) | `OrderBlotter`, `FillsBlotter`, `TradeTape`, `PositionsView` | `#order-blotter`, `#fills-blotter`, `#trade-tape`, `#positions-view` |
| [order-ticket.md](order-ticket.md) | `OrderTicket`, `OrderTicketDialog`, `OrderTicketPanel`, `OrderTicketLauncherProvider` | `#order-ticket-*` |
| [market-depth-and-ladder.md](market-depth-and-ladder.md) | `MarketDepth`, `PriceLadder`, `PriceLadderView` and the depth hooks | `#market-depth-selected`, `#price-ladder-*` |
| [notifications-and-connection.md](notifications-and-connection.md) | `TradingNotificationsProvider`, `ConnectionBanner`, `ConnectionStatusIndicator`, `StaleIndicator` | `#notifications-*`, `#hosting-connection-override` |
| [selection-and-linking.md](selection-and-linking.md) | `InstrumentPicker`, `InstrumentContextProvider`, `LinkGroupProvider`, `LinkGroupSelector`, `LinkGroupSwatch`, `AccountSelector`, `InstrumentLookupProvider` | `#linking-providers`, `#selectors` |
| [charts.md](charts.md) | `PriceChart`, `DepthChartView`, `SpreadChart`, `PnlHistoryChart`, `ExposureTreemap`, `SlippageChart`, `useChartDataSource` | `#price-chart`, `#depth-chart`, `#spread-chart`, `#pnl-history-chart`, `#exposure-treemap`, `#slippage-chart`, `#chart-workspace` |
| [primitives.md](primitives.md) | `SideLabel`, `OrderStatusBadge`, `FillProgressBar`, `PnlValue`, `Sparkline`; theming tokens | `#side-label-variants`, `#primitives-status` |

Conventions shared by every component (placement, CSS injection, utilities, testing, accessibility, MF packaging)
are in the [UI guide](../ui-guide.md). `#trader-workspace` and `#stack-instrument-prices` combine several
components.

## Permissions

The components contain **no role logic**. Roles are enforced on the server and shape the UI only through the host:

- **Server**: the OMS gives every OMS viewport a permission filter (`PermissionFilter("account", visibleAccounts)`)
  and re-checks every RPC (`PERMISSION_DENIED`). So blotters, positions, notifications and the account lists show
  only what the user may see, with no props. Roles (`trading-view`, `trading-execute`, `trading-supervisor`) and
  `oms.permissionMode` (`auto` / `strict`): [OMS permissions](../../packages/oms/README.md#permissions).
- **UI**: the host reads the roles (in the portal features, `useEntitlements()` → `useVuuAuthorizations()` in
  `apps/features/trading/src/features/shared.tsx`) and:
  - passes `readOnly={!canTrade}` to `OrderBlotter` (hides amend / cancel);
  - passes `launchOrderTicket={canTrade}` to `InstrumentGrid` (hides Buy / Sell);
  - does not mount `OrderTicket` / `PriceLadder` for view-only users (vuu-portal only sends the Ticket and Ladder
    modules to users with the `trading-execute-access` nav role).
- Users and their roles in the dev stack: [portal-integration.md](../portal-integration.md#users-and-roles).

Exchange tables (`instruments`, `prices`, `depth`, `trades`, `instrumentPrices`, `bars`, `bookSamples`) are visible to
every user.

## Theming and CSS hooks

- Each component injects its own CSS (`useComponentCssInjection`) and uses the class base `trading<Name>`
  (e.g. `tradingOrderBlotter`), with BEM-like `-part` children.
- Colours are `--trading-*` custom properties that fall back to Salt tokens: override them per app
  ([primitives.md](primitives.md#theming)).
- State is exposed as `data-*` attributes (`data-side`, `data-status`, `data-direction`, `data-stale`,
  `data-connection-state`, `data-link-group`, ...) for CSS and tests. The full list per component is in the
  [catalogue](../api/components.md#css-hooks).
- Density and mode follow the enclosing `SaltProvider` (the showcase uses `vuu-theme`, density `high`).
