# Options: OptionChain, the option ticket and Greeks

API: [OptionChain](../api/trading-ui.md#optionchain), [useOptionChain](../api/trading-ui.md#useoptionchain).
Showcase: `#option-chain-ticket`, `#option-chain-positions`, `#instrument-grid-options`.
App: **Market › Option chain** (module 125, [portal integration](../portal-integration.md)), also in the Panels
palette. The trading server lists options on AAPL.OQ and STECH (`exchangeSim.options` in
`apps/portal-config/application.trading.conf`); set it to `""` for none.

The exchange simulator lists a chain of European options on each underlying in `exchangeSim.options` (AAPL.OQ and the
STECH index in local mode): monthly expiries, strikes around the price. Only the strikes nearest the money have an
order book (`instruments.liquid` true); the rest are **quote-only**: they show a theoretical bid and ask on `prices`
and take no orders. Each option's model value, implied vol and Greeks are on `optionAnalytics`. See the
[exchange-sim README](../../packages/exchange-sim/README.md) for the model and expiry.

## OptionChain

One expiry at a time (tabs), strikes down the middle, calls on the left and puts on the right with bid, ask, implied
vol and delta. Subscribes to `instrumentPrices` (options of the underlying) and `optionAnalytics`.

| Prop | |
| --- | --- |
| `underlying` | A ric or its root (`AAPL` finds `AAPL.OQ`). Default: follow the link group's selected instrument: a stock or index, or the underlying of a selected option or future. |
| `onSelect` | Called with the `ChainOption` the user picks. |
| `launchOrderTicket` | Default true: Enter or a click on a liquid strike's bid opens a Sell ticket at the bid, on its ask a Buy ticket at the ask (OrderTicketLauncher). |
| `linkGroup`, `defaultLinkGroup`, `showLinkGroupSelector` | As other linked components. Picking an option publishes it to the link group. |

- **Liquid strikes** have an accent bar on the strike and full-strength text; **quote-only** strikes are dimmed, their
  quotes only select (no ticket). The at-the-money strike (nearest the forward) has a rule above it and scrolls into
  view; in-the-money cells are shaded; the linked option's row is selected.
- **Keyboard.** One quote cell is in the tab order. ↑ / ↓ strikes, ← / → call bid, call ask, put bid, put ask; Page Up
  / Page Down change expiry; Enter (or Space) picks the option and trades it; B / S open a Buy / Sell ticket on it.
- **Vols** are as priced on the sim's clock: the underlying's vol scaled by √`timeScale`.

`useOptionChain(underlying)` gives the same data headless: `{ chain, loaded }`, where `chain` has `expiries`,
`strikes` (per expiry), `forwards` and `byRic`. The model functions (`buildOptionChain`, `stepStrike`, `stepExpiry`,
`otherRight`, `nearestLiquid`, `parseOptionSpec`, `resolveOptionSpec`) are exported too.

## The option ticket

`OrderTicket` works on options with nothing to configure. The OMS copies the option terms (`underlying`, `putCall`,
`strike`, `expiry`, `liquid`) onto the `orderEntry` row, and the ticket adds a line under the instrument:

- the terms (`Call 175 · 20 Nov · on AAPL.OQ`), implied vol, delta and the **premium** (quantity × price × the
  contract multiplier of 100);
- on a quote-only strike: *Quote only: no book, no orders* and a button for the nearest liquid strike of the same
  expiry and right. The OMS refuses the order too (`RESTRICTED_INSTRUMENT`, naming that strike).

Quantity is in contracts. Keys, from any field:

| Key | |
| --- | --- |
| `Alt+↑` / `Alt+↓` | Next strike up / down (same expiry and right). |
| `Alt+Shift+↑` / `Alt+Shift+↓` | Next / previous expiry, nearest strike. |
| `Alt+C` | The other right (call ↔ put) on the same strike. |

**Order lines** take options: a strike word (`200c`, `102.5p`) with an underlying (a ric, or a root such as `aapl`)
and an optional month (`jan`, `jan27`). `aapl 200c` is the front-month 200 call, `b 10 aapl 200p jan @ 3.5` a full
order, `s 5 175p` an option on the ticket's own underlying. The ticket looks the option up in its chain; if it is not
listed it says so (*No AAPL 1 call is listed*).

## Risk

- **Collar.** The OMS's limit price collar (`oms.collarPct`, 10%) would refuse ordinary option orders: a premium moves
  several times as much as its underlying. For options it is at least 50% of the reference price and at least 10
  ticks (`collarWidth` in trading-schemas, used by the OMS and the ticket).
- **Order limits** use the premium notional, as for any instrument.
- **Delta limit.** Each account has `maxDeltaUsd` (by default its `maxPositionNotional`): the net delta in USD on one
  underlying, a stock with its futures and options. An order that adds to it beyond the limit is rejected
  (`EXCEEDS_MAX_DELTA`); one that reduces it is allowed. The ticket shows the breach before sending.

## Greeks in positions

`positions` has `delta` (shares or index units equivalent), `deltaUsd`, `gamma` (delta per point of the underlying)
and `vegaUsd` (per vol point), from the option's model Greeks; a stock or future is delta one (its delta is quantity ×
multiplier, its `deltaUsd` its market value). The OMS recomputes them on each mark to market. `PositionsView` shows
them, summed when grouped: group by **underlying** to net a stock with its futures and options.

## Instrument grid

The grid's Type column is a badge (`OPT`, `FUT`, `EQ`, `IDX`, `CONT`; `trading.instrument-type`), the C/P column
`trading.put-call`, and an **Options** column set (ric, type, underlying, C/P, strike, expiry, book, quotes, phase)
is offered when the data source has a `strike` column. Filter Type = OPTION (quick filter) or pass
`instrumentType="OPTION"` for options only.

## CSS hooks

`.tradingOptionChain` with `-header`, `-expiries`, `-expiry[aria-selected]`, `-table`, `-row[data-liquid][data-atm]
[aria-selected]`, `-strike`, `-quote[data-tradeable][data-itm]`, `-bid`, `-ask`, `-iv`, `-delta`, `-footer`.
Ticket: `.tradingOrderTicket-option` (`[data-notice]`), `-optionTerms`, `-quoteOnly`, `-nearestLiquid`,
`-optionKeys`.
