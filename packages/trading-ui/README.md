# @heswell/trading-ui

Reusable trading React components built on Vuu (`@vuu-ui/*`) and Salt. They do not depend on a particular data
source: the same component runs on local test data, against a Vuu server, or as a module-federation feature
inside vuu-portal. **Conventions: [docs/ui-guide.md](../../docs/ui-guide.md).**

| Docs | |
| --- | --- |
| [Getting started](../../docs/getting-started.md) | Build an app with these components (remote vuu-server or engine-local) |
| [Component guides](../../docs/components/README.md) | Purpose, data, RPCs, roles, CSS hooks and examples per component |
| [API reference](../../docs/api/trading-ui.md) | Generated from the sources: every export, its props, types and defaults |
| [Showcase](../../apps/showcase/README.md) | A runnable example of every component (`bun run dev:showcase`) |

| Area | Exports |
| --- | --- |
| Data | `TradingDataProvider` (`inherit` / `local` / `remote`), `useTradingDataSource(table, options?)`, `useTradingDataMode`, `useHasDataProvider`, `connectToVuuServer`, `disconnectFromVuuServer`, `sendTradingRpc`, `TradingRpcError`, `tradingTableSchema`, `tradingVuuTable`, `tradingColumnNames` |
| Instrument linking (P3.11) | `useSelectedInstrument({ linkGroup? })`, `SelectedInstrument`, link groups (`DEFAULT_LINK_GROUPS`, `UNLINKED`, `LinkGroupProvider`), `useComponentLinkGroup`, `LinkGroupProps`, `LinkGroupSelector` / `LinkGroupSwatch`, the bus (`getInstrumentLinkBus`, `createInstrumentLinkBus`, `connectBroadcastChannel`), optional `InstrumentContextProvider`. See [ui-guide §5](../../docs/ui-guide.md#5-instrument-linking-p311). |
| Formatting | `formatPrice`, `priceDecimals`, `formatQuantity`, `formatNotional`, `formatPercent` |
| Colours | `TradingColour`, `sideColour`, `directionColour`, `orderStatusCategory`, `orderStatusColour`, `tradingPhaseColour` |
| User settings | `UserSettingsStorage`, `UserSettingsProvider`, `useUserSettingsStorage`, `createLocalSettingsStorage`, `createMemorySettingsStorage` |
| Components | `SideLabel` (reference component), `InstrumentGrid`, `Sparkline` / `trading.sparkline` renderer, `OrderTicket` / `OrderTicketDialog` / `OrderTicketPanel` + `useOrderTicketLauncher` ([guide](../../docs/components/order-ticket.md)), `InstrumentPicker`, `ConnectionBanner`, `ConnectionStatusIndicator`, `StaleIndicator` |
| Rows | `useDataSourceRows(dataSource, config)` → `{ rows, size, loaded, version }`, `useTradingRows(table, { filter, rowCount })` → `{ dataSource, rows, size, loaded }`, `subscribeTradingRows(dataSource, config, listener)`, `toTradingRow`, `TradingRow` ([ui-guide §12](../../docs/ui-guide.md#12-order-ticket-notifications-and-connection-state-p36-p312)) |
| Notifications, connection | `TradingNotificationsProvider`, `useTradingNotifications`, `TradingOrderEvent`, `useTradingConnectionStatus`, `useVuuConnectionStatuses`, `useStaleIndicator`, `useStaleData` ([guide](../../docs/components/notifications-and-connection.md)); reconnect: `createResilientConnectionRegistry`, `ReconnectSupervisor`, `ReconnectPolicy`, `connectionStateStore` ([resilience.md](../../docs/resilience.md)) |

```tsx
const Orders = () => {
  const dataSource = useTradingDataSource("parentOrders");
  return <Table config={config} dataSource={dataSource} />;
};
```
