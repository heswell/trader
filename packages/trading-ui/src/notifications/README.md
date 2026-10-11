# Order notifications and connection state (P3.12)

## Mounting (host / portal): once

```tsx
<TradingDataProvider mode="inherit">
  <InstrumentContextProvider>
    <TradingNotificationsProvider notificationsCenter>   {/* toasts */}
      <OrderTicketLauncherProvider>                      {/* openOrderTicket() */}
        <ConnectionBanner />                             {/* disconnected / reconnecting */}
        {features}
      </OrderTicketLauncherProvider>
    </TradingNotificationsProvider>
  </InstrumentContextProvider>
</TradingDataProvider>
```

- `notificationsCenter` wraps the children in vuu's `NotificationsProvider` (`@vuu-ui/vuu-notifications`). Leave
  it off when the host (vuu-portal shell) already mounts one. The published provider uses one shared context, so
  nested providers shadow each other (upstream #35). Mount exactly one.
- The provider subscribes to `parentOrders` and `fills`, filtered to the trader (default: the authenticated user,
  or the `trader` prop). It toasts every order event, including fills arriving later for resting orders, flow from
  other screens and amends or cancels done elsewhere. It does not toast the initial snapshot.
- Without a data provider (for example in a pure UI test) the streams are off, and `notify()` still works.

## `TradingNotificationsProvider` props

| Prop | Default | |
| --- | --- | --- |
| `trader` | authenticated user | Filter `trader = "…"`. |
| `scope` | `"trader"` | `"visibleAccounts"`: every order the user can see. The admin sees all flow, so this can be noisy. |
| `streams` | `true` | Subscribe to `parentOrders` / `fills`. When false, only `notify()` calls toast. |
| `kinds` | `DEFAULT_NOTIFICATION_KINDS` | Per event kind on/off: `submitted` (off), `ack`, `reject`, `fill`, `filled` (off), `cancel`, `replace` (off), `expire`. |
| `sound` | `false` | Beep on fills. It needs `enableSound()` from a user gesture. |
| `rateLimit` | `{ max: 4, perMs: 1000 }` | Above this, events are summarised in one "N more order updates" toast. |
| `dedupeMs` | `30000` | The same event (`fill:execId`, `kind:clOrdId`) is shown once. |
| `notificationsCenter` | `false` | Mount vuu `NotificationsProvider` (see above). |
| `toastSink` | vuu `showNotification` | Custom toast output (tests, a different toast system). |
| `onNotification` | – | Called for every event shown. |

## `useTradingNotifications()`

```ts
const { notify, settings, updateSettings, enableSound, provided } = useTradingNotifications();
notify({ kind: "reject", clOrdId, ric, side, reason, text, source: "ladder" });
updateSettings({ kinds: { fill: false }, sound: true });
<Checkbox onChange={() => enableSound()} />  // call inside the click handler
```

- **Grid and ladder components.** Pass their `onOrderEvent` events to `notify` only for errors that never reach
  the OMS (for example RPC transport errors). The streams already toast everything that creates a `parentOrders`
  row. Events carrying the same `clOrdId` are deduped.
- **Outside a provider.** `notify` shows a vuu toast directly, and `provided` is `false`.

**Event model.** `TradingOrderEvent { kind, orderId?, clOrdId?, ric?, side?, quantity?, price?, account?, status?, reason?, text?, execId?, fillQty?, fillPx?, cumQty?, avgPx?, currency?, source? }`.
Helpers: `orderEventKindForStatus`, `orderEventKey`, `describeOrderEvent`, `orderEventFromParentOrder` and
`orderEventFromFill`. The building blocks can be used on their own: `NotificationGate` (dedupe + rate limit),
`ParentOrderEventTracker`, `FillEventTracker` and `FillSound`.

## Connection state and staleness

| Export | |
| --- | --- |
| `useTradingConnectionStatus(connectionId?)` | `{ state: "connected" \| "connecting" \| "reconnecting" \| "disconnected" \| "failed", status, connectionId, local, since }`. Local test data is always `connected`. Remote mode uses the provider's `connectionId`. Inherit mode uses the portal's Vuu connection. |
| `toConnectionState(status)` | Maps a vuu `ConnectionStatus`. |
| `ConnectionBanner` | A Salt `Banner` (`role="alert"`, `data-connection-state`) shown when not connected. Props: `connectionId?`, `state?` (override), `messages?`. |
| `useStaleIndicator({ lastUpdate?, staleAfterMs?, connectionId? })` | `{ stale, reason?: "disconnected" \| "reconnecting" \| "noUpdates", connectionState, ageMs }`. Stale while the connection is not up, or (when `staleAfterMs` is set) when `lastUpdate` has not changed for that long. Age is measured on the client clock from when `lastUpdate` last changed, so server clock skew does not matter. |
| `StaleIndicator` | A small `role="status"` badge (`data-stale-reason`). It takes the same options as the hook, or a `reason` override. |
