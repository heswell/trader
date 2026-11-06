# Simulator monitoring

Reference: [SimBooksGrid](../api/trading-ui.md#simbooksgrid), [BotsGrid](../api/trading-ui.md#botsgrid),
[BotDetail](../api/trading-ui.md#botdetail), [BotFillsTape](../api/trading-ui.md#botfillstape),
[SimInstrumentChart](../api/trading-ui.md#siminstrumentchart).

Showcase: `#simulator-monitor`, `#simulator-instrument`. Features: Simulator › Overview, Bots and Instrument
([portal integration](../portal-integration.md#features)). Design: [simulator bots](../simulator-bots.md).

| Component | Tables | RPCs | Roles |
| --- | --- | --- | --- |
| `SimBooksGrid` | `simBooks` | – | `sim-admin` |
| `BotsGrid` | `bots` | – | `sim-admin` |
| `BotDetail` | `bots`, `botParams`, `botHistory`, `botFills` (one bot) | – | `sim-admin` |
| `BotFillsTape` | `botFills` | – | `sim-admin` |
| `SimInstrumentChart` | `simSamples` | – | `sim-admin` |

The exchange module serves these tables only to users with the `sim-admin` role (`exchangeSim.permissionMode`,
see [packages/exchange-sim/README.md](../../packages/exchange-sim/README.md#configuration)); others get no rows.
The rows refresh every `simPublishIntervalMs` (1s). Public market data stays anonymous: only these tables name the
bots.

`BotsGrid` also takes `followInstrument` (only the linked instrument's bots). `SimBooksGrid`, `BotsGrid` and
`BotFillsTape` wrap themselves in `InstrumentLookupProvider` and publish the selected row's
instrument to their link group (`LinkGroupProps`).

| Component | Props |
| --- | --- |
| `SimBooksGrid` | `defaultSort` (`ric` (default) \| `gap` \| `spread` \| `inventory` \| `volume`, largest first; `SIM_BOOKS_SORT`). One row per simulated book: phase, fair and mid, gap and spread in bp, model and realised volatility, flow rates, trade imbalance, market-maker inventory. |
| `BotsGrid` | `defaultGrouping` (`kind` (default) \| `none` \| `ric` \| `account`; `BOTS_GROUP_BY`), `ric`, `onBotSelect(botId?)`. Group rows sum position, USD position and P&L, orders, fills, volume and resting orders. |
| `BotDetail` | `botId`. The bot's stats, a P&L sparkline, its parameters with units and ranges (read only for now) and its recent fills. |
| `BotFillsTape` | `ric` (default: the followed instrument), `party` (one bot id or `OMS:<account>`, on every instrument), `hideToolbar`. Newest first, with the markout once it is known. |
| `SimInstrumentChart` | `ric` (default: the followed instrument). Fair value, walk, mid, bid and ask over time; below, signed aggressive volume per owner group, stacked (`SIM_FLOW_GROUPS`). Fair above walk = transient impact from buying. |

```tsx
const [botId, setBotId] = useState<string>();
<SimBooksGrid defaultSort="gap" showLinkGroupSelector />
<BotsGrid onBotSelect={setBotId} />
<BotDetail botId={botId} />
```

## CSS hooks

Class bases `tradingSimGrid` (the grids and the fills tape), `tradingBotDetail` and `tradingSimInstrumentChart`. Test ids
`trading-sim-books-grid`, `trading-bots-grid`, `trading-bot-fills-tape`, `trading-bot-detail`, `trading-bot-params`,
`trading-bot-pnl-sparkline`; `data-link-group` on the grids, tape and chart.
