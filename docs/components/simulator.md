# Simulator monitoring

Reference: [SimBooksGrid](../api/trading-ui.md#simbooksgrid), [BotsGrid](../api/trading-ui.md#botsgrid),
[BotDetail](../api/trading-ui.md#botdetail), [BotFillsTape](../api/trading-ui.md#botfillstape),
[SimInstrumentChart](../api/trading-ui.md#siminstrumentchart), [SimSessionStrip](../api/trading-ui.md#simsessionstrip),
[ScenarioRuns](../api/trading-ui.md#scenarioruns), [SimEventsLog](../api/trading-ui.md#simeventslog),
[SimInstrumentControls](../api/trading-ui.md#siminstrumentcontrols), [ClientBotsGrid](../api/trading-ui.md#clientbotsgrid),
[ClientBotDetail](../api/trading-ui.md#clientbotdetail).

Showcase: `#simulator-monitor`, `#simulator-instrument`, `#simulator-control`, `#simulator-clients`. Features: Simulator › Overview, Bots, Instrument and Metrics
([portal integration](../portal-integration.md#features)). Design: [simulator bots](../simulator-bots.md).

| Component | Tables | RPCs | Roles |
| --- | --- | --- | --- |
| `SimBooksGrid` | `simBooks` | – | `sim-admin` |
| `BotsGrid` | `bots` | – | `sim-admin` |
| `BotDetail` | `bots`, `botParams`, `botHistory`, `botFills` (one bot) | `setBotParams`, `pauseBots`, `resumeBots`, `pullQuotes`, `resetBotStats`, `removeBot` | `sim-admin` |
| `BotFillsTape` | `botFills` | – | `sim-admin` |
| `SimInstrumentChart` | `simSamples` | – | `sim-admin` |
| `ClientBotsGrid` | `clientBots` (OMS) | `addClientBot` | `sim-admin` |
| `ClientBotDetail` | `clientBots`, `clientBotParams` (OMS, one bot), `botFills` | `setClientBotParams`, `pauseClientBots`, `resumeClientBots`, `removeClientBot`, `submitClientAlgo` | `sim-admin` |

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
| `BotDetail` | `botId`. The bot's stats, a P&L sparkline, actions (pause / resume, pull quotes, reset stats, remove), its parameters as an editable form with units and ranges (`*` marks a value changed from its baseline, with Reset), and its recent fills. |
| `BotFillsTape` | `ric` (default: the followed instrument), `party` (one bot id or `OMS:<account>`, on every instrument), `hideToolbar`. Newest first, with the markout once it is known. |
| `SimInstrumentChart` | `ric` (default: the followed instrument). Fair value, walk, mid, bid and ask over time; below, signed aggressive volume per owner group, stacked (`SIM_FLOW_GROUPS`). Fair above walk = transient impact from buying. |
| `ClientBotsGrid` | `onBotSelect(botId?)`, `hideToolbar`. The OMS client bots (simulated clients sending TWAP / VWAP / POV parents): working parents, sent / rejected / done, filled quantity and USD, slippage against arrival, last reject. The toolbar adds a bot of a persona. |
| `ClientBotDetail` | `botId`. A client bot's stats, Pause / Resume and Remove, a form to send one algo parent now (ric, side, notional, strategy, duration), its parameters (the same editable form as `BotDetail`) and its account's attributed fills (`OMS:<account>`). |

```tsx
const [botId, setBotId] = useState<string>();
<SimBooksGrid defaultSort="gap" showLinkGroupSelector />
<BotsGrid onBotSelect={setBotId} />
<BotDetail botId={botId} />
<ClientBotsGrid onBotSelect={setClientBotId} />
<ClientBotDetail botId={clientBotId} />
```

The Bots feature shows the exchange bots above the client bots, with the selected one's detail beside them.

## Control

| Component | Tables | RPCs | Roles |
| --- | --- | --- | --- |
| `SimSessionStrip` | `simSession`, `scenarios` | `setMarketPhase`, `pauseBots`, `resumeBots`, `runScenario` | `sim-admin` |
| `ScenarioRuns` | `scenarioRuns` | `stopScenario` | `sim-admin` |
| `SimEventsLog` | `simEvents` | – | `sim-admin` |
| `SimInstrumentControls` | `simBooks`, `bots` | `setInstrumentParams`, `shiftFairValue`, `setBotRate`, `pauseBots`, `resumeBots`, `pullQuotes`, `addBot`, `haltInstrument`, `resumeInstrument` | `sim-admin` |

Changes apply at once; each shows in `SimEventsLog` with the user. Each control shows the outcome of its last RPC
(`useSimRpc`, which sends through the component's own data source).

| Component | Props |
| --- | --- |
| `SimSessionStrip` | Phase (forced or scheduled), next change, session clock, paused bots and running scenarios; Pre-open / Open / Close, Pause and Resume all bots, and a scenario picker with Run (default targets and args). |
| `ScenarioRuns` | Newest first: status, step, user, targets; Stop, and Stop and revert (Revert once finished). |
| `SimEventsLog` | Newest first: time, user, action, target, details, run. |
| `SimInstrumentControls` | `ric` (default: the followed instrument), `LinkGroupProps`. Volatility, drift and impact with Apply; fair-value jumps of ±25 and ±100 bp (with "informed trader (30s)", the jump arms an informed trader: `informedSecs`); market maker and taker rates; pause, resume and pull the instrument's bots; Add bot of any kind (`SIM_BOT_KINDS`); Halt / Resume. |

## Server metrics

Reference: [MetricsGrid](../api/trading-ui.md#metricsgrid), [MetricsTablesGrid](../api/trading-ui.md#metricstablesgrid),
[MetricsSessionsGrid](../api/trading-ui.md#metricssessionsgrid),
[MetricsProcessStrip](../api/trading-ui.md#metricsprocessstrip), [MetricHistoryChart](../api/trading-ui.md#metrichistorychart).
Showcase: `#server-metrics`. Feature: Simulator › Metrics. Design: [server metrics](../metrics.md).

| Component | Tables | Roles |
| --- | --- | --- |
| `MetricsProcessStrip` | `metricsProcess`, `metricsHistory` (`component = "process"`) | `sim-admin` |
| `MetricsGrid` | `metrics` | `sim-admin` |
| `MetricsTablesGrid` | `metricsTables` | `sim-admin` |
| `MetricsSessionsGrid` | `metricsSessions` | `sim-admin` |
| `MetricHistoryChart` | `metricsHistory` (one metric) | `sim-admin` |

The METRICS tables are served only to users with `sim-admin`, like the simulator tables. They are written once per
`metrics.intervalMs` (1 s).

| Component | Props |
| --- | --- |
| `MetricsProcessStrip` | `onSelectMetric`. A card per process value (`PROCESS_CARDS`: CPU, RSS, heap used, loop lag p99 and max) with its latest value over a sparkline of its history, so the trend is there as soon as it opens. Clicking a card selects `process.<name>`. Without a process row (the in-browser data) it says "No process metrics". |
| `MetricsGrid` | `defaultComponent` (`METRICS_COMPONENTS`: all, `exchange`, `publisher`, `gateway`, `oms`, `vuu`), `onSelectMetric`. Every metric: value, rate, unit and the timer percentiles, with trends of the rate and of p99 (client sparklines, built from updates while the row is visible). |
| `MetricsTablesGrid` | `onSelectMetric`. Every Vuu table, busiest first: rows, writes per second (with a trend), writes, counted. Selecting a counted table selects `table.<MODULE.table>`. |
| `MetricsSessionsGrid` | None. Every client session, most backed-up first: user, queued updates (with a trend), rows sent per second (with a trend), coalesced %, messages and KB per second, rows sent and dropped since login, connected time and session id. Empty on the in-browser data. |
| `MetricHistoryChart` | `metric` (`SelectedMetric`: `id`, `kind`, `unit`). A timer's p50 / p99 / max, a counter's rate or a gauge's value over the last `metrics.historySize` snapshots (5 minutes by default). `metricHistorySeries(kind)` and `metricHistoryAxis(metric)` give what is charted. |

```tsx
const [metric, setMetric] = useState<SelectedMetric>({ id: "process.cpuPct", kind: "gauge", unit: "%" });
const select = (next?: SelectedMetric) => next && setMetric(next);
<MetricsProcessStrip onSelectMetric={select} />
<MetricsGrid onSelectMetric={select} />
<MetricHistoryChart metric={metric} />
<MetricsTablesGrid onSelectMetric={select} />
<MetricsSessionsGrid />
```

## CSS hooks

Class bases `tradingSimGrid` (the grids and the fills tape), `tradingBotDetail` and `tradingSimInstrumentChart`. Test ids
`trading-sim-books-grid`, `trading-bots-grid`, `trading-bot-fills-tape`, `trading-bot-detail`, `trading-bot-params`,
`trading-bot-pnl-sparkline`, `trading-bot-param-changed`, `trading-client-bots-grid`, `trading-client-bot-detail`,
`trading-client-bot-params`, `trading-client-bot-submit`; `data-link-group` on the grids, tape and chart. Controls use
class base `tradingSimControls`, test ids `trading-sim-session-strip`, `trading-sim-phase`, `trading-scenario-runs`,
`trading-sim-events-log`, `trading-sim-instrument-controls`. Server metrics use class bases `tradingServerMetrics`
(grids), `tradingMetricsProcess` (strip; `data-metric` on each card) and `tradingMetricHistoryChart` (`data-metric`),
test ids `trading-metrics-grid`, `trading-metrics-tables-grid`, `trading-metrics-sessions-grid`, `trading-metrics-process`.
