# OrderTicket (P3.6)

One form core (`useOrderTicket`), shown in three layouts:

| Export | Use |
| --- | --- |
| `OrderTicket` | The form. `variant="panel"` (default) or `"compact"` (a dense inline strip for a grid row or ladder). |
| `OrderTicketDialog` | `OrderTicket` in a modal Salt `Dialog` (`open`, `onClose`, `title`, `size`). |
| `OrderTicketPanel` | A docked `OrderTicket` that also receives `openOrderTicket()` prefills while it is mounted. |
| `OrderTicketLauncherProvider` / `useOrderTicketLauncher()` | Open a ticket with a prefill from anywhere. |
| `useOrderTicket(props)` | The headless form state, for a custom layout. |
| `orderTicketModel` functions | Pure helpers: `validateDraft`, `previewRisk`, `nudgePrice`, `nudgeQuantity`, `parseQuantity`, `parsePrice`, `fieldForRejectReason`, `newClOrdId`, … |

## Props (`OrderTicket`, and the same on `OrderTicketDialog` / `OrderTicketPanel`)

| Prop | Default | |
| --- | --- | --- |
| `prefill` | – | `OrderTicketPrefill` (below). A **new object** replaces the draft, so pass a fresh object for each request. |
| `variant` | `"panel"` | `"panel"` or `"compact"`. |
| `showInstrumentPicker` | `true` | When false, the RIC is shown as a label. |
| `followSelection` | `true` | Default the instrument from its link group's selection, and follow it while the draft is clean. |
| `linkGroup` / `defaultLinkGroup` / `onLinkGroupChange` / `showLinkGroupSelector` | inherited | Link group (`LinkGroupProps`, ui-guide §5). |
| `publishSelection` | `true` | Picking an instrument calls `setSelectedInstrument(inst, "orderTicket")`. |
| `onOrderEvent` | – | `(event: TradingOrderEvent) => void`. Fires on the RPC result (ack, fill, reject) and on later status changes of the submitted order. |
| `onClose` | – | Esc on a clean form (Esc on a dirty form resets it first). |
| `notify` | `true` | Also report events to `TradingNotificationsProvider`, when one is mounted. |
| `rememberAccount` | `true` | Remember the last used account in `localStorage` (`trading.orderTicket.lastAccount`). |
| `clOrdIdPrefix` | `"TKT"` | The prefix for the ticket's own `clOrdId`. |
| `usdPerPriceUnit` | `INDICATIVE_USD_PER_PRICE_UNIT` | Indicative FX for the USD preview and the limit warnings. Pass `{}` to hide USD. |
| `collarPct` | `0.1` | Client-side collar warning (the same as the OMS default `collarPct`). |
| `actions` | – | Extra buttons placed before Reset / Submit. |
| …div attributes | | Spread on the root element (`role="form"`, `data-side`, `data-submission`). |

### Prefill

```ts
interface OrderTicketPrefill {
  ric?: string;
  instrument?: SelectedInstrument; // when you already have the static data
  side?: Side;                     // "BUY" | "SELL"
  price?: number;                  // limit price
  quantity?: number;
  ordType?: OrdType;               // "MARKET" | "LIMIT"
  timeInForce?: TimeInForce;       // "DAY" | "GTC" | "IOC" | "FOK"
  account?: string;
}
```

From a grid Buy/Sell action or a ladder click:

```tsx
const { openOrderTicket } = useOrderTicketLauncher();
<Button onClick={() => openOrderTicket({ ric, side: Side.Buy, price: bid })}>Buy</Button>
```

`openOrderTicket` routes to the most recently mounted `OrderTicketPanel` if there is one. Otherwise it opens an
`OrderTicketDialog`. Without an `OrderTicketLauncherProvider` it is a no-op, and `available` is `false`, so a
component can hide its button. For an inline ticket, render `<OrderTicket variant="compact" prefill={…} />`
directly.

## Behaviour

- **Instrument.** An `InstrumentPicker` (a Salt ComboBox over `instruments`) searches by RIC prefix or by
  description. The live header shows bid, ask, last, change and phase from `instrumentPrices`, plus a
  `StaleIndicator`. Clicking Bid or Ask sets the limit price.
- **Order types and TIF.** MARKET and LIMIT (`SUPPORTED_ORD_TYPES`; the OMS does not support STOP). DAY, GTC,
  IOC and FOK, except MARKET + GTC.
- **Validation.**
  - Client side, `validateDraft` uses `validateOrder` and `validateRpcParams("createOrder")` from
    trading-schemas, which cover lot size, tick (tick-band aware), price required and price > 0.
  - Account: required, visible to the user and not disabled. Disabled accounts are excluded from the list.
  - Errors appear once a field has been touched or a submit has been attempted.
- **Risk preview.**
  - Notional = quantity × price (the limit price, or the far touch for market orders), in the instrument currency.
    GBX notionals are in pence.
  - An indicative USD equivalent is shown.
  - Warnings for the account's `maxOrderQty` and `maxOrderNotional` (USD), and for the ±`collarPct` collar.
  - Warnings are advisory: the OMS is authoritative.
- **Submit.**
  - Uses `sendTradingRpc("createOrder")` with the ticket's own `clOrdId`. The ticket follows its own
    `parentOrders` row (filter `clOrdId = …`), so it shows pending → ack → partial or complete fill.
  - On a reject it shows `parseRpcError`'s reason and text. Some rejects map to a field (for example
    PRICE_OUTSIDE_COLLAR → price).
  - With `OMS_GATEWAY_LATENCY_MS=200` the ticket shows "Pending acknowledgement" first.
- **Keyboard.** Scoped to the ticket element.

| Key | Action |
| --- | --- |
| `B` / `S` | Buy / Sell. Works in the price and quantity fields, but not in the instrument search. |
| `↑` / `↓` in price | ± one tick at the current price band. `Shift` = 10 ticks. An empty price starts from the touch. |
| `↑` / `↓` in quantity | ± one lot. `Shift` = 10 lots. |
| `F9`, `Ctrl/⌘+Enter` | Submit |
| `Esc` | Reset a dirty form, otherwise `onClose`. Ignored while a dropdown is open. |

## Known gaps

- FX rates for the USD preview are indicative constants that mirror the simulator; they are not live.
- STOP and STOP_LIMIT are not offered, because the OMS does not support them.
- Amend and cancel are not part of the ticket (they belong to the blotters). They are enabled only for NEW,
  PARTIALLY_FILLED and REPLACED orders.
