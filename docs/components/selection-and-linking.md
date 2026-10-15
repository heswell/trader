# Selection and instrument linking (P3.11)

Reference: [InstrumentPicker](../api/trading-ui.md#instrumentpicker),
[InstrumentContextProvider](../api/trading-ui.md#instrumentcontextprovider),
[LinkGroupProvider](../api/trading-ui.md#linkgroupprovider),
[LinkGroupSelector](../api/trading-ui.md#linkgroupselector), [LinkGroupSwatch](../api/trading-ui.md#linkgroupswatch),
[AccountSelector](../api/trading-ui.md#accountselector),
[InstrumentLookupProvider](../api/trading-ui.md#instrumentlookupprovider),
[useSelectedInstrument](../api/trading-ui.md#useselectedinstrument),
[useComponentLinkGroup](../api/trading-ui.md#usecomponentlinkgroup). The design (bus, transports, persistence of
the chosen group) is in [ui-guide §5](../ui-guide.md#5-instrument-linking-p311).

Showcase: `#linking-providers`, `#selectors`, `#trader-workspace` (everything linked).

| Component | Tables | Notes |
| --- | --- | --- |
| `InstrumentPicker` | `instruments` (`instrumentSearchFilter`: ric prefix or description) | Controlled by `value` / `onSelect`, or `linked` (default when neither is given) to show and publish the link group's instrument. Class base `tradingInstrumentPicker`. |
| `InstrumentContextProvider` | – | Gives a subtree a private bus (or `bus`), a default `linkGroup` (default `DEFAULT_LINK_GROUP`, `"red"`), an `initialInstrument` and `onSelectionChange`. Optional. |
| `LinkGroupProvider` | – | Puts a subtree in `linkGroup`. A component's own `linkGroup` prop wins. |
| `LinkGroupSelector` / `LinkGroupSwatch` | – | Colour picker over `DEFAULT_LINK_GROUPS` (red, green, blue, yellow) plus `unlinked`. Class base `tradingLinkGroupSelector`. |
| `AccountSelector` | `accounts` (via `useTradingAccounts` / `useSelectedAccount`) | Dropdown of enabled accounts visible to the user. |
| `InstrumentLookupProvider` | `instruments` (once; nested providers reuse it) | Static data by ric for renderers and `setSelectedInstrument`. |

No role logic: what the pickers list is what the OMS / exchange lets the user see (see
[permissions](README.md#permissions)).

## How linking works

Every component that shows or picks an instrument joins a **link group** (a colour). Selecting an instrument
publishes it to the group; every other component in the group follows. Components never talk to each other.

```tsx
const { selectedInstrument, setSelectedInstrument } = useSelectedInstrument({ linkGroup: "green" });
```

- Without any provider, components share the window-wide bus (`getInstrumentLinkBus()`) in the default group. This
  is what lets separately mounted module-federation features link.
- `InstrumentContextProvider` isolates a subtree (tests, embedded previews) unless you pass
  `bus={getInstrumentLinkBus()}`.
- `connectBroadcastChannel(bus)` links windows / tabs of the same origin (`DEFAULT_LINK_CHANNEL_NAME`);
  `TradingFeatureRoot` does it for portal features (`ensureLinkBusBroadcast`).
- Components with `LinkGroupProps` (`linkGroup`, `defaultLinkGroup`, `onLinkGroupChange`, `showLinkGroupSelector`)
  remember the user's choice with the layout via `useComponentLinkGroup`.

```tsx
<InstrumentContextProvider initialInstrument={{ ric: "VOD.L" }}>
  <LinkGroupProvider linkGroup="red">
    <InstrumentPicker />
    <MarketDepth />
  </LinkGroupProvider>
  <LinkGroupProvider linkGroup="green">
    <InstrumentPicker />
    <PriceLadder />
  </LinkGroupProvider>
</InstrumentContextProvider>
```

## Accounts

```tsx
const [account, setAccount, accounts] = useSelectedAccount();
<AccountSelector accounts={accounts} value={account} onChange={setAccount} />
```

`useSelectedAccount` picks the caller's choice, else the order ticket's last account, else the first visible one.
The portal features build an account toolbar for depth and ladder from these two (`useAccountToolbar` in `apps/features/trading/src/features/shared.tsx`).

## CSS hooks

`data-link-group` on every linked component's root; `tradingLinkGroupSelector`, `tradingInstrumentPicker` class
bases. Link group colours use Salt categorical tokens (`--salt-categorical-*-background`) with fallbacks.
