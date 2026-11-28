# Trading limits

Reference: [LimitMonitor](../api/trading-ui.md#limitmonitor), [LimitBreaches](../api/trading-ui.md#limitbreaches),
[IncreaseRequestDialog](../api/trading-ui.md#increaserequestdialog), [KillSwitchDialog](../api/trading-ui.md#killswitchdialog),
[UtilisationBar](../api/trading-ui.md#utilisationbar), [LimitStateBadge](../api/trading-ui.md#limitstatebadge).

Showcase: `#limit-monitor`, `#limit-breaches`, `#limit-ticket`. Feature: Oversight › Limits
([portal integration](../portal-integration.md#features)). Design: the trading limits boards
([docs/design](../design/README.md)). Server side: [OMS limits](../../packages/oms/README.md#limits).

| Component | Tables | RPCs | Roles |
| --- | --- | --- | --- |
| `LimitMonitor` | `limitUtilisation` (grouped by `desk`, `entityId`), `limitEntities`, `killSwitches`; `positions`, `parentOrders` and `limitOverrides` for the contributors | `requestLimitIncrease`, `killSwitch`, `releaseKillSwitch` | view; the dialogs' RPCs are checked by the OMS |
| `LimitBreaches` | `limitBreaches`, `limitBreachEvents` (the selected breach), `limitRequests` (pending) | `acknowledgeBreach`, `escalateBreach`, `commentBreach`, `requestLimitIncrease`, `approveLimitRequest`, `rejectLimitRequest`, `killSwitch` | view; approve, reject, release and desk or firm kill switches need `trading-supervisor` |
| `IncreaseRequestDialog` | – | `requestLimitIncrease` | the account's `trading-execute` or `trading-supervisor` |
| `KillSwitchDialog` | – | `killSwitch` | an account: its `trading-execute` or `trading-supervisor`; a desk or the firm: `trading-supervisor` |

The OMS enforces every rule; the components only disable actions while disconnected. An approver must be someone
other than the requester, so in local mode (where the user is `admin`) a request can be sent but not approved by
the same user.

| Component | Props |
| --- | --- |
| `LimitMonitor` | `defaultShow` (`all` (default) \| `near` \| `breached`), `defaultFamily` (`all` \| `order` \| `position` \| `risk` \| `pnl`; `LIMIT_FAMILIES`), `showContributors` (default true). A tree of every limit by desk then entity: utilisation bars with ticks at warning, the limit and (dotted) hard; group rows show the highest utilisation. Selecting a limit shows its contributors (the positions and working orders of the accounts under it, and the orders sent over it with an override) and enables Request increase… and Kill switch. Active kill switches show as banners with Turn trading back on. The footer counts limits by state. |
| `LimitBreaches` | `defaultStatus` (`open` (default) \| `acknowledged` \| `closed` \| `all`), `defaultSeverity`, `defaultBreachId` (e.g. from a notification), `supervisor` (the approver named on Request increase). Today's breaches; the detail pane has the facts, the timeline, a comment box (Enter sends) and Acknowledge, Request increase…, Escalate and Kill switch. Pending increase requests show above with Approve and Reject. |
| `IncreaseRequestDialog` | `target` (`IncreaseTarget`: the limit, its use and levels, and an optional breach), `dataSource`, `approver`, `onClose`. New limit (accepts `k` / `m` / `b`), the hard limit keeping its margin, expiry (end of day 22:00, end of week, or a date; `expiryTime`), reason and detail. |
| `KillSwitchDialog` | `entities` (the scope chain: account, desk, firm), `workingOrders(entityId)`, `dataSource`, `breachId`, `defaultReason`, `onClose`, `onDone`. Scope, cancel working orders, reason. |
| `UtilisationBar` | `utilisation`, `warningPct`, `hardPct`, `state`. A `role="img"` bar (`aria-label` "Utilisation 90%") on a 125% scale. |

Cell renderers (`registerLimitRenderers()`, `limitRenderer(name)`): `trading.limit-utilisation`,
`trading.limit-state`, `trading.limit-metric`, `trading.limit-time`. Formatting helpers: `formatLimitAmount`,
`formatUtilisation`, `metricLabel`, `limitLabel`, `familyFilter`, `LIMIT_STATE_LABEL`.

## Order ticket

The `OrderTicket` shows the OMS's pre-trade limit check (the `orderEntry` `limitCheck` column,
`decodeLimitCheck`): one `LimitCheckLine` per limit the order is checked against, with usage before and after, its
state, whether the order breaks it, and the largest quantity under its hard limit. `limitCheckState` gives the
ticket's state:

| State | Ticket |
| --- | --- |
| `WARNING` | A card with the limits nearest their levels; no extra step. |
| `SOFT_BREACH` | Sending opens the override step: a reason (`LimitOverrideReason`, keys `1`–`4`) and a note, needed for `OTHER`. `sendOrder` carries `overrideReason` / `overrideNote`, and the OMS writes a `limitOverrides` row per limit. |
| `HARD_BREACH` | Send is blocked. Use the largest quantity that fits (`Alt+U`), or Request increase… on the blocking limit. |

`checkLimits` (an OMS RPC) returns the same check for any order without placing it. See
[order-ticket.md](order-ticket.md) for the keys.

## Theming

Class bases `tradingLimits` and `tradingLimitsDialog`. State colours are `--tradingLimits-*` tokens (`-ok`,
`-warning`, `-soft`, `-hard`, `-track`, `-tick`, `-hard-row`), with dark values under `[data-mode="dark"]`. In dark
mode the components also set dark row selection and a dark foreground for Salt's actionable-bold colours (the
group-by pills and solid neutral buttons), which vuu-theme renders white on white.
