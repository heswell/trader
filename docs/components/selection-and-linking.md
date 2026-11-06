# Selection and instrument linking (P3.11)

Reference: [InstrumentPicker](../api/trading-ui.md#instrumentpicker),
[InstrumentContextProvider](../api/trading-ui.md#instrumentcontextprovider),
[LinkGroupProvider](../api/trading-ui.md#linkgroupprovider),
[LinkGroupSelector](../api/trading-ui.md#linkgroupselector), [LinkGroupSwatch](../api/trading-ui.md#linkgroupswatch),
[LinkGroupMenuButton](../api/trading-ui.md#linkgroupmenubutton), [PanelLinkGroupSelector](../api/trading-ui.md#panellinkgroupselector),
[AccountSelector](../api/trading-ui.md#accountselector),
[InstrumentLookupProvider](../api/trading-ui.md#instrumentlookupprovider),
[useSelectedInstrument](../api/trading-ui.md#useselectedinstrument),
[useComponentLinkGroup](../api/trading-ui.md#usecomponentlinkgroup). The design (bus, transports, persistence of
the chosen group) is in [ui-guide §5](../ui-guide.md#5-instrument-linking-p311).

Showcase: `#linking-providers`, `#selectors`, `#panel-link-group`, `#trader-workspace` (everything linked).

| Component | Tables | Notes |
| --- | --- | --- |
| `InstrumentPicker` | `instruments` (`instrumentSearchFilter`: ric prefix or description) | Controlled by `value` / `onSelect`, or `linked` (default when neither is given) to show and publish the link group's instrument. Class base `tradingInstrumentPicker`. |
| `InstrumentContextProvider` | – | Gives a subtree a private bus (or `bus`), a default `linkGroup` (default `DEFAULT_LINK_GROUP`, `"red"`), an `initialInstrument` and `onSelectionChange`. Optional. |
| `LinkGroupProvider` | – | Puts a subtree in `linkGroup`. A component's own `linkGroup` prop wins. |
| `LinkGroupSelector` / `LinkGroupSwatch` | – | Colour picker over `DEFAULT_LINK_GROUPS` (red, green, blue, yellow) plus `unlinked`. Class base `tradingLinkGroupSelector`. |
| `LinkGroupMenuButton` / `PanelLinkGroupSelector` | – | Icon-only selector for panel title bars (see [panel headers](#panel-headers)). |
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

## Workspace channel picker

A title-bar picker (`ChannelPicker`) that combines the channel (link group) selector with an instrument search. The
trader portal shows it in the workspace header; showcase: `#channel-picker-workspace`, `#channel-picker-fit`.

- **Active channel.** `WorkspaceChannelProvider` holds the workspace's active channel (`useWorkspaceChannel`, or
  `useOptionalWorkspaceChannel` outside one). Components in the `active` link group (`ACTIVE_LINK_GROUP`) follow it:
  `useComponentLinkGroup` resolves their `channel` to the active channel (the default group outside a provider).
  Components pinned to a colour keep theirs. Inside a provider the `LinkGroupSelector` offers "Active channel" first;
  its swatch shows the active channel's colour with a ring.
- **Portal wiring.** `apps/portal-host` wraps `PortalShell` in `PortalWorkspaceChannel` (the active channel is kept
  per portal in `localStorage`) and centres `WorkspaceChannelPicker` (the picker on the trading server's connection)
  in the workspace header (`workspaces.headerCenter`). `@heswell/trading-ui` is a shared module-federation singleton, so the remote panels see
  the host's provider. The ticket, chart, depth, depth chart, ladder and tape features default to `active` (so do layouts
  saved before, and panels added from the palette); blotters keep their colours. The Ladder and Tape hide their toolbar instrument
  picker while they follow the active channel.
- Built on Salt: the channels are a `ToggleButtonGroup` (radios: ←→ move between them, one tab stop) of
  `ToggleButton`s, then a search `Button`, styled through Salt's `--toggleButton-*` / `--saltButton-*` variables
  (24px buttons in a 28px strip). Each segment shows the channel's ric. Clicking one makes it the workspace's
  **active channel**.
- The search button (or clicking the active channel again) opens the search: a vuu `Table` over `instrumentPrices`
  drawn with a custom `Row` (`InstrumentSearchRow`). With no text it lists the channels' and recent rics. ↑↓ move,
  Enter publishes the instrument to the active channel, Tab / Shift+Tab switch channel, Esc closes. Focus returns to
  the channel after Enter or Esc, not after a mouse pick.
- Results come in two sections, each its own `Table`: rics starting with the text, then names containing it. Vuu
  filters ignore brackets, so "name matches, ric doesn't" can't be one filter: a lookup of `instruments` (ric +
  description) finds every match and splits them; the name section filters on `ric in [...]`. ↑↓ cross sections.
- Density: `full` (dot, ric, last, change) when all channels fit, else `compact` (dot, ric), else `dots` (only the
  active channel keeps its ric). `density="auto"` (default) measures hidden full / compact copies against the space
  available; give the picker a `minmax(0, max-content)` grid track (or a shrinkable flex item).

## Panel headers

In a portal workspace, the Ticket, Chart, Ladder, Tape, Depth and Depth chart show their link group in the panel's
title bar, not in their body. Their selector is a `PanelLinkGroupSelector`: hosted in a `@vuu-ui/grid-layout`
`GridLayoutItem` (`useGridLayoutItem()`), it renders a `LinkGroupMenuButton` into the item header through a
`GridLayoutHeaderContribution` at `start`, or, in a stack, at `tab-start` (the start of the panel's own tab);
anywhere else it is the inline `LinkGroupSelector`.

- `LinkGroupMenuButton` shows the group's swatch only and opens a Salt `Menu` of the groups. A pinned group is a plain
  dot, following the active channel is a smaller dot in a soft halo of its colour (`--tradingLinkGroupSelector-haloSize`),
  unlinked a hollow ring. Its accessible name and tooltip name the group (`Link group: Active channel (Green)`), so
  assistive tech does not rely on the colour.
- The contribution renders inside the feature's React tree but into the host's header, so `@vuu-ui/grid-layout` is a
  shared module-federation singleton (`scripts/features/sync-build-config.ts`).
- A `GridLayoutItem` with `header: false` has no slot, so the selector does not show there.
- `apps/portal-host/src/App.css` styles the item headers like a stack's tab bar through grid-layout's
  `--vuuGridLayoutItemHeader-*` variables: no fill, the tab bar's divider, text size and 27px height.
- Only the selected panel of a stack is mounted, so the button moves with the selection. In a stack that shows one,
  `App.css` gives every tab the button's width at both ends (labels stay centred, nothing shifts), and lifts tab
  contributions above Salt's `TabTrigger` hit area so they take their own clicks. The first visit to a panel whose
  remote module has not loaded yet still shifts once.

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
