# Simulator monitoring

Reference: [SimBooksGrid](../api/trading-ui.md#simbooksgrid), [BotsGrid](../api/trading-ui.md#botsgrid),
[BotDetail](../api/trading-ui.md#botdetail).

Showcase: `#simulator-monitor`. Features: Simulator › Overview and Simulator › Bots
([portal integration](../portal-integration.md#features)). Design: [simulator bots](../simulator-bots.md).

| Component | Tables | RPCs | Roles |
| --- | --- | --- | --- |
| `SimBooksGrid` | `simBooks` | – | `sim-admin` |
| `BotsGrid` | `bots` | – | `sim-admin` |
| `BotDetail` | `bots`, `botParams` (one bot) | – | `sim-admin` |

The exchange module serves these tables only to users with the `sim-admin` role (`exchangeSim.permissionMode`,
see [packages/exchange-sim/README.md](../../packages/exchange-sim/README.md#configuration)); others get no rows.
The rows refresh every `simPublishIntervalMs` (1s). Public market data stays anonymous: only these tables name the
bots.

`SimBooksGrid` and `BotsGrid` wrap themselves in `InstrumentLookupProvider` and publish the selected row's
instrument to their link group (`LinkGroupProps`).

| Component | Props |
| --- | --- |
| `SimBooksGrid` | `defaultSort` (`ric` (default) \| `gap` \| `spread` \| `inventory` \| `volume`, largest first; `SIM_BOOKS_SORT`). One row per simulated book: phase, fair and mid, gap and spread in bp, model and realised volatility, flow rates, trade imbalance, market-maker inventory. |
| `BotsGrid` | `defaultGrouping` (`kind` (default) \| `none` \| `ric` \| `account`; `BOTS_GROUP_BY`), `ric`, `onBotSelect(botId?)`. Group rows sum position, USD position and P&L, orders, fills, volume and resting orders. |
| `BotDetail` | `botId`. The bot's stats and its parameters with units and ranges (read only for now). |

```tsx
const [botId, setBotId] = useState<string>();
<SimBooksGrid defaultSort="gap" showLinkGroupSelector />
<BotsGrid onBotSelect={setBotId} />
<BotDetail botId={botId} />
```

## CSS hooks

Class bases `tradingSimGrid` (both grids) and `tradingBotDetail`. Test ids `trading-sim-books-grid`,
`trading-bots-grid`, `trading-bot-detail`, `trading-bot-params`; `data-link-group` on the grids.
