# OrderTicket (P3.6)

Reference: [OrderTicket](../api/trading-ui.md#orderticket), [OrderTicketDialog](../api/trading-ui.md#orderticketdialog),
[OrderTicketPanel](../api/trading-ui.md#orderticketpanel),
[OrderTicketLauncherProvider](../api/trading-ui.md#orderticketlauncherprovider),
[useOrderTicket](../api/trading-ui.md#useorderticket).

Showcase: `#order-ticket-docked`, `#order-ticket-dialog`, `#order-ticket-compact`, `#order-ticket-launcher`,
`#hosting-connection-override` (the ticket while the connection is down).

| | |
| --- | --- |
| Tables | `instruments` (picker, `showInstrumentPicker`), `instrumentPrices` (live header), `accounts` (account list and limits), `parentOrders` (the submitted order, filter `clOrdId = …`) |
| RPCs | `createOrder` (`stopPrice` for STOP / STOP_LIMIT) |
| Roles | Submitting needs `trading-execute` (the OMS answers `PERMISSION_DENIED` otherwise). Do not mount a ticket for view-only users: the portal features gate the Ticket and Ladder modules on `trading-execute` (see [permissions](README.md#permissions)). |
| Connection | Submit (button, F9, Ctrl+Enter) is blocked with a reason (`connectionBlockedReason`) unless the connection state is `connected` (`data-connection-state`). |
| Class base | `tradingOrderTicket`; `data-side`, `data-submission`, `data-status`, `data-field`, `data-warning`, `data-order-ticket-field`, `data-show-keys`, `--tradingOrderTicket-sideColor` |

One form core (`useOrderTicket`), shown in three layouts:

| Export | Use |
| --- | --- |
| `OrderTicket` | The form. `variant="panel"` (default) or `"compact"` (one row for a grid row or ladder). |
| `OrderTicketDialog` | `OrderTicket` in a modal Salt `Dialog` (`open`, `onClose`, `title`, `size`). |
| `OrderTicketPanel` | A docked `OrderTicket` that also receives `openOrderTicket()` prefills while it is mounted. |
| `OrderTicketLauncherProvider` / `useOrderTicketLauncher()` | Open a ticket with a prefill from anywhere. |
| `useOrderTicket(props)` | The headless form state, for a custom layout. |
| `orderTicketModel` functions | Pure helpers: `validateDraft`, `previewRisk`, `reviewReasons`, `resolvePriceInput`, `resolveQuantityInput`, `parseOrderLine`, `filterStrategies`, `allowedTimesInForce`, `scheduleSummary`, `nudgePrice`, `nudgeStopPrice`, `nudgeQuantity`, `isStrategyAllowed`, `fieldForRejectReason`, `newClOrdId`, … |

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
| `actions` | – | Extra buttons placed beside Reset. |
| …div attributes | | Spread on the root element (`role="form"`, `data-side`, `data-submission`). |

### Prefill

```ts
interface OrderTicketPrefill {
  ric?: string;
  instrument?: SelectedInstrument; // when you already have the static data
  side?: Side;                     // "BUY" | "SELL"
  price?: number;                  // limit price (LIMIT, STOP_LIMIT)
  stopPrice?: number;              // stop (trigger) price (STOP, STOP_LIMIT)
  quantity?: number;
  ordType?: OrdType;               // "MARKET" | "LIMIT" | "STOP" | "STOP_LIMIT"
  timeInForce?: TimeInForce;       // "DAY" | "GTC" | "IOC" | "FOK"
  account?: string;
  strategy?: AlgoStrategy;         // "DMA" (default) | "TWAP" | "VWAP" | "POV"
}
```

Without `ordType`, a `stopPrice` means STOP (STOP_LIMIT with a `price` too) and a `price` alone means LIMIT. A
stop prefill with an algo `strategy` opens as DMA, and an IOC / FOK `timeInForce` as Day.

From a grid Buy/Sell action or a ladder click:

```tsx
const { openOrderTicket } = useOrderTicketLauncher();
<Button onClick={() => openOrderTicket({ ric, side: Side.Buy, price: bid })}>Buy</Button>
```

`openOrderTicket` routes to the most recently mounted `OrderTicketPanel` if there is one. Otherwise it opens an
`OrderTicketDialog`. Without an `OrderTicketLauncherProvider` it is a no-op, and `available` is `false`, so a
component can hide its button. For an inline ticket, render `<OrderTicket variant="compact" prefill={…} />`
directly.

## Layout

From top to bottom:

- **Header**, tinted with the side colour. The instrument field (it also takes an order line, below), the account,
  and the link group selector when the ticket is not in a grid-layout panel (there it is in the panel title bar).
  Then description, last, change, the trading phase when not continuous, and the account's position (from
  `positions`).
- **Quote.** Sell on the bid and Buy on the ask, with sizes, and the spread and mid between them. Clicking a side
  selects it; the selected side is filled with its colour.
- **Order type and TIF.** Limit / Market / Stop / Stop limit, and a TIF list holding only the TIFs valid now
  (`allowedTimesInForce`).
- **Quantity and price.** The hint under each shows what shorthand resolves to, or where a limit sits against the
  touch ("2 ticks behind the bid", "At the ask, crosses"). Bid / Mid / Ask set the price. A market order shows the
  estimated price instead of a price field. For a stop, a **Stop price** field sits between quantity and price,
  with a hint giving its distance from the market ("3 ticks above the last"). A STOP shows "Market on trigger" in
  place of the limit; a STOP_LIMIT's limit hint gives its distance from the stop.
- **Execution.** The strategy picker, its description, the strategy's parameters with one-click values, and a one
  line schedule ("≈ 334 a minute for 30 min").
- **Footer.** Value (and USD), warnings, the order's status with a fill bar (with the schedule target for algos),
  and the send button. The button says what will be sent ("Buy 5,000 AAL.L @ 435.7") with the strategy, TIF and
  account on a second line.

## Behaviour

- **Instrument.** An `InstrumentPicker` (a Salt ComboBox over `instruments`) searches by RIC prefix or by
  description. Entering the field selects its text, so typing replaces the current instrument.
- **Strategies are data.** `ALGO_STRATEGY_DEFINITIONS` in trading-schemas lists each strategy: name, picker group,
  description, valid TIFs and parameters (`key` = the createOrder field, type `duration` / `time` / `percent`,
  unit, range, required, placeholder, one-click values). The picker, parameter fields, validation, TIF list,
  schedule line and order line all read the definitions. To add a strategy, add a definition (and its OMS
  implementation); a new parameter `type` or `key` also needs the model's parser. The picker filters as you type
  and groups by `group`.
- **Order types and TIF.** MARKET, LIMIT, STOP and STOP_LIMIT (`ORDER_TICKET_ORD_TYPES`). DAY, GTC, IOC and FOK,
  except MARKET + GTC, only DAY / GTC for stops, a strategy's own TIF list, and no IOC / FOK outside continuous
  trading. When a change makes the TIF invalid, the ticket switches to Day and says so beside the TIF.
- **Stops.** The OMS holds a STOP / STOP_LIMIT until a trade reaches the stop price (a buy at or above it, a sell
  at or below), then sends a MARKET (STOP) or a LIMIT at the limit price (STOP_LIMIT).
  - At entry a buy stop must be above the market price and a sell stop below it (market = last trade, else mid,
    else reference price; `validateStopTrigger`). A STOP_LIMIT's limit must be at or above the stop for a buy, at
    or below it for a sell. Both show as field errors before sending.
  - Stops are DMA only. The latest choice wins: picking Stop / Stop limit on an algo order switches the strategy
    to DMA, and picking an algo for a stop turns it into the plain type (STOP → Market, STOP_LIMIT → Limit). The
    ticket says which it changed ("Stops are DMA only: switched to DMA").
  - Switching type clears the prices the new type doesn't have: the stop going to Limit / Market, the limit going
    to Market / Stop. An empty stop isn't defaulted; `↑` / `↓` in it starts one tick beyond the market.
  - The send button reads "Sell 200 VOD.L Stop 99.50" or "Sell 200 VOD.L Stop 99.50 Limit 99.40", and
    `createOrder` gets `stopPrice` (never for other types). Once accepted, the status reads "Waiting for stop
    99.50" until `parentOrders.triggeredAt` is set, then follows the order as usual.
  - A STOP is valued (notional, `$` quantities) at its stop price.
- **Shorthand.**
  - Price and stop price: `b`, `a`, `m` (bid, ask, mid rounded to the tick), with tick offsets (`b+2`, `a-1`).
  - Quantity: `10k`, `1.5m`, or a USD value `$250k` converted at the price (times the contract multiplier for a
    future) and rounded to the lot.
  - Durations `45`, `45m`, `1h`, `1h30`; times `15:30`, `1530`; percent `10`, `10%`.
  - Shorthand resolves to a number when the field is left (Tab, Enter, or on send).
- **Order line.** Type a whole order in the instrument field, e.g. `b 20k aal.l m vwap 15:30` or
  `s 5k mkt pov 10% 1h`: side first, then quantity, instrument (a word with a dot), price, strategy and its
  parameters. After the strategy, a bare number is its next parameter when valid there (`pov 10` = 10%,
  `twap 45` = 45 min), so put a price before the strategy. Stops: `stop` (or `stp`) takes the next price as the
  stop price, so `s 200 vod.l stop 99.5` is a STOP and `s 200 vod.l stop 99.5 lmt 99.4` a STOP_LIMIT. `lmt`
  (`limit`) is optional: any other price is the limit (`b 1k vod.l 101 stp 100.5`).
  Chips under the field show how each word was read. Enter fills the ticket and moves to the send
  button; it does not send. Without an instrument the current one is kept. Text with a space is an order line;
  text without one is a search.
- **Validation.**
  - Client side, `validateDraft` uses `validateOrder` and `validateRpcParams("createOrder")` from
    trading-schemas, which cover lot size, tick (tick-band aware), price required and price > 0. Strategy
    parameters are checked against their definitions.
  - Account: required, visible to the user and not disabled. Disabled accounts are excluded from the list.
  - Errors appear once a field has been touched or a submit has been attempted.
- **Risk preview.**
  - Notional = quantity × price × contract multiplier (the limit price, or the far touch for market orders), in the
    instrument currency. GBX notionals are in pence.
- **Futures and indices.** A future's quantity is in contracts (the unit label reads "contracts"). An index is not
  tradeable: the ticket shows "STECH is an index: trade its futures" on the instrument. Neither is a continuation:
  "AZNc1 is a continuation: trade AZNZ6".
  - An indicative USD equivalent is shown.
  - Warnings for the account's `maxOrderQty` and `maxOrderNotional` (USD), and for the ±`collarPct` collar.
  - Warnings are advisory: the OMS is authoritative.
- **Review.** An order with any of those warnings (`reviewReasons`) goes through a Review step: the send button
  reads "Review …", and sending opens a summary of the order with the reasons. Enter (or Confirm) sends; Esc (or
  Back) returns to the ticket.
- **Submit.**
  - Uses `sendTradingRpc("createOrder")` with the ticket's own `clOrdId`. The ticket follows its own
    `parentOrders` row (filter `clOrdId = …`), so it shows pending → ack → partial or complete fill.
  - On a reject it shows `parseRpcError`'s reason and text. Some rejects map to a field (for example
    PRICE_OUTSIDE_COLLAR → price, MISSING_STOP_PRICE / INVALID_STOP_PRICE → stop price).
  - Once accepted, the quantity is cleared and focus returns to it, ready for the next order; instrument, side,
    price and strategy stay.
  - With `OMS_GATEWAY_LATENCY_MS=200` the ticket shows "Pending acknowledgement" first.
- **Keyboard.** Scoped to the ticket element. Tab runs instrument → quantity → stop price (stops) → price →
  strategy → its parameters → send; the side, type, TIF and one-click buttons are left out of the tab order and
  have shortcuts instead. Hold Alt / Option to see the shortcut badges. A whole stop order can be entered without
  the mouse: `⌥P`, quantity, Enter, `↑` to step the stop from the market, F9.

| Key | Action |
| --- | --- |
| `Alt/⌥+B` / `Alt/⌥+S` | Buy / Sell, from any field. |
| `Alt/⌥+L` / `Alt/⌥+M` | Limit / Market. |
| `Alt/⌥+P` / `Alt/⌥+Shift+P` | Stop / Stop limit (P for stoP: S is Sell). |
| `Alt/⌥+T` | Next valid TIF. |
| `Alt/⌥+E` | Go to the strategy picker. |
| `B` / `S` | Buy / Sell, in the quantity field and on buttons (not in price, which takes `b` shorthand, or the instrument field). |
| `Enter` | Accept the field (resolving shorthand) and move to the next one. In the instrument field, fill from an order line. |
| `↑` / `↓` in price | ± one tick at the current price band. `Shift` = 10 ticks. An empty price starts from the touch. |
| `↑` / `↓` in stop price | The same; an empty stop starts one tick beyond the market (above it for a buy, below for a sell). |
| `↑` / `↓` in quantity | ± one lot. `Shift` = 10 lots. |
| `↑` / `↓` in a parameter | ± 5 minutes or 1%. `Shift` = ×10. |
| `F9`, `Ctrl/⌘+Enter` | Send (or open Review). In Review, `Enter` confirms. |
| `Esc` | Close Review; otherwise reset a dirty form; otherwise `onClose`. Ignored while a list is open. |

## Known gaps

- No %ADV sizing or ADV display: no table carries ADV yet. Planned as a separate change.
- The schedule line gives durations and end times only; it can't give a finish clock time (the UI has no session
  clock).
- The compact variant puts strategy parameters inline on its one row.

- FX rates for the USD preview are indicative constants that mirror the simulator; they are not live.
- Stops can't be combined with an algo strategy (the OMS works them DMA only).
- Amend and cancel are not part of the ticket (they belong to the blotters). They are enabled only for NEW,
  PARTIALLY_FILLED and REPLACED orders.
