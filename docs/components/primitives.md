# Primitives: side, status, progress, P&L, sparkline

Small presentational components with no data subscription, no RPCs and no role logic. Use them in your own
components or cells. They never convey meaning by colour alone (icon, sign, arrow or text as well).

Showcase: `#side-label-variants`, `#primitives-status`, `#primitives-cell-renderers`.

| Component | Reference | Purpose | Class base / attributes |
| --- | --- | --- | --- |
| `SideLabel` | [API](../api/trading-ui.md#sidelabel) | Buy / Sell text or pill (`variant`), `--trading-buy` / `--trading-sell` | `tradingSideLabel`, `data-side` |
| `OrderStatusBadge` | [API](../api/trading-ui.md#orderstatusbadge) | FIX OrdStatus as icon + text; reject reason / text as tooltip | `tradingOrderStatusBadge`, `data-status`, `data-category` |
| `FillProgressBar` | [API](../api/trading-ui.md#fillprogressbar) | `filled / total` bar, `role="progressbar"`; `muted` for cancelled / rejected | `tradingFillProgressBar`, `data-pct` |
| `PnlValue` | [API](../api/trading-ui.md#pnlvalue) | Signed amount with sign, arrow and colour; `currency`, `hideArrow` | `tradingPnlValue`, `data-direction` |
| `Sparkline` | [API](../api/trading-ui.md#sparkline) | SVG polyline of `values`, trend in colour, `data-trend` and the accessible name | `tradingSparkline`, `data-trend` |

The table cell renderers (`PriceMoveCell`, `ChangeCell`, `QuantityCell`, `PhaseCell`, `SparklineCell` and the
`trading.order-status`, `trading.side`, ... family) are described in
[instrument-grid.md](instrument-grid.md#cell-renderers) and [blotters.md](blotters.md#shared-pieces).

```tsx
<SideLabel side="BUY" variant="pill" />
<OrderStatusBadge status="REJECTED" rejectReason="PRICE_OUTSIDE_COLLAR" text="Price outside collar" />
<FillProgressBar filled={250} total={1000} />
<PnlValue value={-1234.5} currency="USD" />
<Sparkline values={[101, 102.5, 101.8, 103]} />
```

## Theming

Colours come from `TradingColour` (`utils/colours.ts`): every `--trading-*` custom property falls back to a Salt
token, so the components follow the Salt theme and mode, and an app overrides them in CSS:

| Token | Used for | Falls back to |
| --- | --- | --- |
| `--trading-buy` / `--trading-sell` | sides | `--salt-sentiment-positive/negative-foreground-informative` |
| `--trading-up` / `--trading-down` / `--trading-neutral` | change, P&L, sparkline trend | sentiment positive / negative, `--salt-content-secondary-foreground` |
| `--trading-status-pending` / `-working` / `-filled` / `-rejected` / `-done` | order status, trading phase | `--salt-status-warning/info/success/error-foreground-informative`, secondary foreground |
| `--trading-depth-bid` / `--trading-depth-ask` | depth and ladder bars | see `MarketDepth.css` / `PriceLadder.css` |

```css
.my-app {
  --trading-buy: teal;
  --trading-sell: crimson;
}
```

Helpers: `sideColour`, `directionColour`, `orderStatusCategory`, `orderStatusColour`, `tradingPhaseColour`. CSS is
injected with the component (`useComponentCssInjection`), see
[ui-guide §2](../ui-guide.md#2-styling-css-injection-and-salt--vuu-theming).
