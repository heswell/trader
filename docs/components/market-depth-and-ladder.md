# Market depth (P3.4) and price ladder (P3.5)

Both components live in `@heswell/trading-ui`. They follow the selected instrument (`useSelectedInstrument()`) unless
you pass an explicit `ric`. They read EXCHANGE `depth`, `instrumentPrices` and `trades`, plus OMS `parentOrders`,
through `useTradingDataSource`, so they work against both the local test data and a remote server.

Showcase examples: `#market-depth-selected`, `#price-ladder-live` and `#price-ladder-stress`.

## MarketDepth

Aggregated two-sided book (bid | ask). Each side shows orders, quantity and price columns.

- **Depth bars** show cumulative quantity and grow outwards from the centre line. Side is conveyed by column
  position and `Bid` / `Ask` headers as well as colour.
- **Own orders**: working orders show a `◆ qty` marker at their price (screen readers hear "own").
- **Flash**: levels flash when their quantity changes.
- **Summary row**: spread (absolute and in ticks), mid and the trading phase.

```tsx
<MarketDepth account="ACC-US-01" levels={5} onLevelClick={({ side, price }) => prefillTicket(side, price)} />
<MarketDepth ric="VOD.L" showOwnOrders={false} />
```

| Prop | Type | Default | Notes |
| --- | --- | --- | --- |
| `ric` | `string` | selected instrument | Explicit instrument override. |
| `levels` | `number` | `10` | 1–10 per side (the exchange publishes `depthLevels = 10`). |
| `showOwnOrders` | `boolean` | `true` | Join own working orders (`useOwnWorkingOrders`). |
| `account` | `string` | all visible | Restrict own orders to one account. |
| `flash` | `boolean` | `true` | Flash levels on quantity change (honours `prefers-reduced-motion`). |
| `showDepthBars` | `boolean` | `true` | Cumulative-quantity bars. |
| `onLevelClick` | `({ side, price, level }) => void` | – | When set, prices become buttons. |
| …`HTMLAttributes<div>` | | | Forwarded to the root (the ref is forwarded too). |

States:

- **No instrument**: shows "Select an instrument".
- **Empty book**: shows "No orders in the book".
- **HALTED / CLOSED / POST_CLOSE**: shows a phase badge and dims the table.

Switching instrument clears the rows straight away, so the old book never shows under the new ric.

## PriceLadder (data-bound) and PriceLadderView (presentational)

A price-centred vertical ladder with one row per tick, built from the trading-schemas tick schedule (tick bands are
supported). Columns: **My bids | Bid qty | Price | Ask qty | My offers | (Volume)**.

- **Highlights**: the best bid, best ask and LTP are highlighted. Quantity cells carry proportional bars.
- **Auto-centre** follows mid / LTP.
  - It re-centres only when the reference leaves the middle band, so the ladder doesn't jitter.
  - Scrolling (wheel, keyboard, or dragging past the edge) turns auto-centre off.
  - `Centre` or `C` re-centres.
- **Click-to-trade**: click a bid cell to buy a limit order at that price, or an ask cell to sell.
  - Modes: `confirm` (default; an inline confirm bar, Enter / Escape) or `one-click`.
  - Set the quantity in the toolbar (default 100, rounded up to the lot size).
- **Amend**: drag an own order to another price. This calls `amendOrder` for each actionable order there. The keyboard
  path is `M`, then the arrows, then Enter.
- **Cancel**:
  - Double-click an own-order cell, or press `Delete` at the cursor, to cancel every own order at that level. If the
    cursor is on an own-order column, only that side is cancelled.
  - **Cancel all** calls `cancelAll` for the ric.
- Amend and cancel apply only to NEW, PARTIALLY_FILLED and REPLACED orders (see `actionableOrders`). Amends lose
  queue priority on the exchange.

```tsx
<PriceLadder
  account="ACC-US-01"
  showVolume
  defaultTradeMode="confirm"
  onOrderEvent={(e) => log(e)}
  onError={(error, action) => toast(`${action.type}: ${error.reason}`, error.message)}
/>
```

### PriceLadder props

Supports every `PriceLadderViewProps` prop except the data props (`bids`, `asks`, `ownOrders`, `tickSchedule`,
`on*Orders`, …), plus:

| Prop | Type | Default | Notes |
| --- | --- | --- | --- |
| `ric` | `string` | selected instrument | |
| `account` | `string` | – | Account for new orders. It also filters own orders. Without it, new orders are disabled ("No account: view only"). |
| `levels` | `number` | `10` | Depth levels per side. |
| `timeInForce` | `TimeInForce` | `DAY` | |
| `clOrdIdPrefix` | `string` | `"LDR"` | A unique `clOrdId` is generated for each order. |
| `onOrderEvent` | `(e: PriceLadderOrderEvent) => void` | – | Fires after each successful RPC, one of: `{ type: "create", request, response }`, `{ type: "amend", order, price, response }`, `{ type: "cancel", order, response }`, `{ type: "cancelAll", ric, account?, response }`. |
| `onError` | `(error: TradingRpcError, action: PriceLadderAction) => void` | – | The error is parsed with `parseRpcError` (`reason`, `message`) and also shown in the status line. |

Orders go through `sendTradingRpc` on the ladder's `parentOrders` viewport (`createOrder`, `amendOrder`,
`cancelOrder`, `cancelAll`). New orders are disabled while the phase is HALTED, CLOSED or POST_CLOSE.

### PriceLadderView props

A pure view, driven entirely by props. Use it with your own data (as the stress example does), or to put the ladder
behind a different data layer.

| Prop | Type | Notes |
| --- | --- | --- |
| `ric`, `priceFormat`, `tickSchedule`, `lotSize` | | Rows need a `tickSchedule` (use `instrumentTickSchedule(inst)`). |
| `bids`, `asks` | `readonly { price, size }[]` | Best first. |
| `last`, `referencePrice` | `number` | `last` drives the LTP highlight. Centring uses mid, then last, then the reference price. |
| `ownOrders` | `ReadonlyMap<string, OwnOrdersAtPrice>` | Keyed by `ownOrdersKey(side, price)`. |
| `tradedVolume`, `showVolume` | `ReadonlyMap<number, number>`, `boolean` | Keyed by `priceKey(price)`. |
| `rowCount` | `number` | Default: fills the height (min 5). |
| `autoCentre` / `defaultAutoCentre` / `onAutoCentreChange` | | Controlled or uncontrolled. On by default. |
| `quantity` / `defaultQuantity` / `onQuantityChange` | | |
| `tradeMode` / `defaultTradeMode` / `onTradeModeChange` | `"confirm" \| "one-click"` | Default `confirm`. |
| `tradingEnabled`, `disabledReason` | | Disables new orders only. |
| `status`, `statusKind` | `ReactNode`, `"info" \| "error"` | Status line in a live region. |
| `onTrade` | `({ side, price, quantity }) => void` | |
| `onAmendOrders`, `onCancelOrders` | `(orders: OwnOrder[], price) => void` | |
| `onCancelAll` | `() => void` | The button is hidden when omitted and disabled when there are no own orders. |

### Keyboard and accessibility

The ladder (`<table role="grid">`) is a single tab stop. The cursor cell is exposed through `aria-activedescendant`
rather than a roving tabindex. Rows are recycled by slot, so moving DOM focus would chase ticking prices. Price cells
are labelled with their state (e.g. "3,440, last traded, best ask"), and own-order cells with their totals
(e.g. "my bids 500 in 2 orders").

| Key | Action |
| --- | --- |
| ↑ / ↓ (Shift: ×5), PageUp / PageDown | Move the price cursor. At the edges this scrolls and turns auto-centre off. |
| ← / → | Move the cursor column. |
| `B` / `S` | Buy / sell at the cursor price (in confirm mode this opens the confirm bar). |
| Enter / Space | Trade on a bid / ask column, confirm a pending order, or drop a keyboard move. |
| `Delete` / Backspace | Cancel own orders at the cursor level. |
| `M` | Start a keyboard move of own orders at the cursor, then use the arrows and Enter (Escape aborts). |
| `C` | Re-centre. |
| `L` | Toggle auto-centre (scroll lock). |
| Escape | Cancel a pending confirm or move. |

### Performance

The view renders a fixed set of recycled rows (slot keys), each memoised on its own props, so a depth update
re-renders only the rows that changed.

Numbers below come from the `#price-ladder-stress` showcase example. Setup: synthetic book, about 40 visible rows,
React Profiler plus an rAF frame counter, 10 s runs, headless Chrome on an Apple Silicon Mac, dev build.

| Target updates/s | Achieved | FPS (min) | Commit avg / p95 / max (ms) | Frames > 33 ms |
| --- | --- | --- | --- | --- |
| 50 | 50 | 60 (60) | 2.02 / 8.8 / 9.7 | 0 |
| 100 | 100 | 60 (60) | 1.29 / 7.4 / 9.0 | 0 |
| 200 | 197 | 60 (60) | 0.98 / 2.3 / 8.2 | 0 |

Production builds are faster: there are no dev checks and no Profiler overhead. For comparison, the real exchange
publishes depth roughly every 100 ms per instrument.

## Shared hooks and utilities

These are exported from `@heswell/trading-ui` for other components to reuse.

| Export | Purpose |
| --- | --- |
| `useViewportRows(dataSource, options)` | Subscribes to a `DataSource` and returns plain row objects keyed by column. Use it for non-table components. |
| `useMarketDepth(ric, levels?)` | `depth` rows for a ric, split into `bids` / `asks`, best first, with cumulative sizes. |
| `useInstrumentPrice(ric)` | The live `instrumentPrices` row (static data, prices and phase). |
| `useTradedVolume(ric, enabled?)` | Traded quantity per price: `trades` grouped by price. Limited to the trades ring buffer. |
| `useFollowedInstrument(ric?)` | The explicit ric, or else the selected instrument, merged with its live prices. |
| `useOwnWorkingOrders(ric, { account? })` | Working LIMIT `parentOrders` for a ric, plus `byPrice` keyed by `ownOrdersKey(side, price)`. |
| `actionableOrders(orders)` | Keeps only NEW / PARTIALLY_FILLED / REPLACED orders. |
| `useLevelFlash(levels, version, resetKey)` | Flash state per `levelKey(side, price)` when quantity changes. |
| `tradingPhaseText`, `isInactivePhase(phase)`, `instrumentTickSchedule(inst)` | Phase labels, a halted / closed check, and a `TickSchedule` built from instrument static data. |
| `ladderPrices`, `ladderReferencePrice`, `needsRecentre`, `priceKey` | Ladder maths (built on `stepTicks`). |

## Known gaps

- The exchange simulator doesn't populate `depth.ownSize`. Own quantity comes from a client-side `parentOrders`
  subscription, so it covers only OMS orders the user can see.
- Traded volume at price covers only the trades still held in the exchange's trades ring buffer.
- The CSS class base is `trading<Name>`, following ui-guide §1.
