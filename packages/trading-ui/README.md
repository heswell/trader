# @heswell/trading-ui

Reusable trading React components built on Vuu (`@vuu-ui/*`) and Salt. They do not depend on a particular data
source: the same component runs on local test data, against a Vuu server, or as a module-federation feature
inside vuu-portal. **Conventions: [docs/ui-guide.md](../../docs/ui-guide.md).**

| Area | Exports |
| --- | --- |
| Data | `TradingDataProvider` (`inherit` / `local` / `remote`), `useTradingDataSource(table, options?)`, `useTradingDataMode`, `useHasDataProvider`, `connectToVuuServer`, `disconnectFromVuuServer`, `sendTradingRpc`, `TradingRpcError`, `tradingTableSchema`, `tradingVuuTable`, `tradingColumnNames` |
| Instrument context (P3.11 placeholder) | `InstrumentContextProvider`, `useSelectedInstrument`, `SelectedInstrument`, `InstrumentContextValue` |
| Formatting | `formatPrice`, `priceDecimals`, `formatQuantity`, `formatNotional`, `formatPercent` |
| Colours | `TradingColour`, `sideColour`, `directionColour`, `orderStatusCategory`, `orderStatusColour`, `tradingPhaseColour` |
| Components | `SideLabel` (reference component) |

```tsx
const Orders = () => {
  const dataSource = useTradingDataSource("parentOrders");
  return <Table config={config} dataSource={dataSource} />;
};
```

Tests: `bun run test:ui` (bun:test + @testing-library/react on happy-dom).
