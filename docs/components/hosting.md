# Hosting: data, feature roots and host services

How to host the trading components: where their data comes from, which services the host mounts once, and how a
module-federation (MF) feature wraps itself. For a step-by-step app, see [getting-started.md](../getting-started.md).

Reference: [TradingDataProvider](../api/trading-ui.md#tradingdataprovider),
[connectToVuuServer](../api/trading-ui.md#connecttovuuserver),
[TradingFeatureRoot](../api/trading-ui.md#tradingfeatureroot),
[OrderTicketLauncherProvider](../api/trading-ui.md#orderticketlauncherprovider),
[UserSettingsProvider](../api/trading-ui.md#usersettingsprovider),
[TradingConnectionStateOverride](../api/trading-ui.md#tradingconnectionstateoverride),
[createTradingLocalServer](../api/trading-test-data.md#createtradinglocalserver).

Showcase: `#hosting-feature-root`, `#hosting-connection-override`, `#hosting-user-settings`. Every showcase example
runs inside the same host composition (`apps/showcase/src/ShowcaseApp.tsx`, `ShowcaseTradingHost.tsx`).

## TradingDataProvider

Components never construct data sources: they call `useTradingDataSource` / `useTradingRows` (or
`useData().VuuDataSource`). `TradingDataProvider` decides what that means for everything below it:

| `mode` | Extra prop | Data from | Used by |
| --- | --- | --- | --- |
| `inherit` | – | the enclosing `@vuu-ui/core` `DataProvider` | MF features inside vuu-portal (the portal host provides it) |
| `local` | `localServer: LocalVuuServer` | an in-browser engine, e.g. `createTradingLocalServer()` | the showcase, tests, demos |
| `remote` | `connectionId: string` | a connection opened with `connectToVuuServer({ connectionId, ... })` | stand-alone apps, the showcase's remote mode |

Without a provider the mode is `inherit` (`useTradingDataMode()`), and `useHasDataProvider()` tells you whether an
enclosing `DataProvider` exists.

`connectToVuuServer({ connectionId, websocketUrl, authUrl, username, password?, reconnect?, loginTimeoutMs? })`
authenticates against the server's REST login and opens the WebSocket under a reconnect supervisor (backoff
1 s → 30 s; see [resilience.md](../resilience.md)). `disconnectFromVuuServer(connectionId)` closes it.

## Host services (mount once)

| Service | Why once |
| --- | --- |
| `TradingNotificationsProvider` | One `parentOrders` + `fills` subscription for the whole window; nested providers shadow each other (trader upstream issue 35). `trader` defaults to the authenticated user name. See [notifications-and-connection.md](notifications-and-connection.md). |
| `OrderTicketLauncherProvider` | `useOrderTicketLauncher().openOrderTicket(prefill)` from the grid, ladder, positions; opens a docked `OrderTicketPanel` if mounted, else a dialog. See [order-ticket.md](order-ticket.md#prefill). |
| `ConnectionBanner` | One banner for the connection state. |
| vuu `NotificationsProvider` | The toast centre. vuu-portal mounts it; a stand-alone app passes `notificationsCenter` to `TradingNotificationsProvider` instead. |

The showcase host, for reference:

```tsx
<TradingNotificationsProvider notificationsCenter trader={SHOWCASE_USER}>
  <OrderTicketLauncherProvider>
    <ConnectionBanner />
    {children}
  </OrderTicketLauncherProvider>
</TradingNotificationsProvider>
```

## TradingFeatureRoot

What every trading MF feature wraps itself in (see `withFeatureRoot` in
`apps/features/trading/src/features/shared.tsx`):

```tsx
export const OrdersFeature = () => (
  <TradingFeatureRoot>
    <OrderBlotter readOnly={!useEntitlements().canTrade} />
  </TradingFeatureRoot>
);
```

(`useEntitlements` is the features app's helper in `shared.tsx`; it reads the trading roles with
`useVuuAuthorizations()` from `@vuu-ui/core`.)

- The outermost root mounts `TradingNotificationsProvider` (with `InstrumentLookupProvider`),
  `OrderTicketLauncherProvider` and `ConnectionBanner` (`connectionBanner`, default true). Only one root per window
  streams notifications (a window-global lease, `notificationLease`), so several open features do not toast each event
  twice (`notifications`, default true).
- A root nested in another root (a composite feature rendering child modules) renders its children only
  (`useInTradingFeatureRoot()`).
- Every root connects the window link bus to `BroadcastChannel` once (`ensureLinkBusBroadcast`), so popped-out
  features stay linked.
- Data is inherited from the portal's `DataProvider`. `scope="visibleAccounts"` streams notifications for every account the user can see (the trader features use the default, `trader`).

Portal setup, remotes and module config: [portal-integration.md](../portal-integration.md#per-host-services-tradingfeatureroot), MF
packaging: [ui-guide §10](../ui-guide.md#10-packaging-a-component-as-an-mf-feature-appsfeaturestrading).

## UserSettingsProvider

Per-user settings (currently `InstrumentGrid` watchlists, key `trading.watchlists`) go through a
`UserSettingsStorage`: `getItem` / `setItem`, which may return promises. The default is localStorage
(`createLocalSettingsStorage`, with an in-memory fallback). Override it for a subtree:

```tsx
const portalStorage: UserSettingsStorage = {
  getItem: (key) => api.loadSetting(key),
  setItem: (key, value) => api.saveSetting(key, value),
};
<UserSettingsProvider storage={portalStorage}>
  <InstrumentGrid />
</UserSettingsProvider>
```

## TradingConnectionStateOverride

Makes `useTradingConnectionStatus()` report a fixed `state` (`connecting`, `reconnecting`, `disconnected`,
`failed`, ...) inside it, so stale greying, the banner and ticket / ladder blocking can be shown and tested without a
server. `state={undefined}` reports the real state.

## Permissions

The components contain no role checks; the host decides what to mount and the OMS enforces roles on every RPC and
row. See [permissions](README.md#permissions).
