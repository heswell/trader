# Trading limits: design spec

These are the source files of the design canvas, kept with the code as the spec.

- Live canvas: https://claude.ai/artifact/FmWSutmPWFBF6JJyMrb9FZ
- Implementation plan: none yet

| Board | Shows |
| --- | --- |
| Main.dc.html | Limit monitor · tree grid by desk and account, contributors split, light |
| MonitorDark.dc.html | Limit monitor · dark |
| KillSwitch.dc.html | Kill switch · stop trading for a trader, account, desk or the firm |
| Breaches.dc.html | Breaches · blotter with detail pane (chart, timeline, comment, actions) |
| IncreaseRequest.dc.html | Request temporary increase · dialog |
| SetupTree.dc.html | Limit setup · Tree view, read-only: Firm → desk → account → RIC rows, one column per limit, inherited values in italics, cell details popover |
| SetupTreeSession.dc.html | Limit setup · Tree view, edit session: set a value on a desk, accounts that set their own keep it or are reset, a value above a parent's cap blocks Save |
| Setup.dc.html | Limit setup · List view, read-only, with pending change sets locked; Edit limits starts a session |
| SetupSession.dc.html | Limit setup · List view, edit session: vuu editable cells, a left bar marks cells edited in the session |
| SaveSession.dc.html | Limit setup · Save for approval dialog: the session becomes one change set, with a reason |
| AddLimit.dc.html | Limit setup · Add limit dialog, adds a row to the session |
| Approve.dc.html | Limit setup · checker approves change set #12 |
| Templates.dc.html | Limit setup · templates: edit a named set of limits, see which accounts differ, import and export CSV |
| ApplyTemplate.dc.html | Limit setup · apply a template to accounts: fill missing or match, preview, add to the edit session |
| Ticket.dc.html | Order ticket · pre-trade check: warning, soft breach override, hard block |

`canvas.json` holds the board layout and four section headings (monitor, breaches, setup, order ticket).

## Model shown

- Hierarchy: Firm → desk → account (the OMS `accounts` table: EQ-US, EQ-EU, EQ-ASIA, SIM-CLIENTS). Each level
  holds its own limits. A desk's own limits sit under a "Desk total" node.
- Limits: order quantity, order notional, order rate, position notional (each RIC, one RIC or underlying), gross
  position notional, net delta, daily loss. Periods are intraday, overnight, day and rolling windows.
- Three levels: warning (a percentage), the limit itself (soft: an override with a reason) and hard (a percentage
  above the limit: the order is rejected).
- The utilisation bar runs from 0 to 125%. Ticks mark 80% and 100%, and a dotted red tick marks the hard limit.
  Status uses a label as well as colour.
- Every change to a limit goes through maker-checker. Temporary increases expire.

## Building it with vuu-ui and Salt

Work in progress on the vuu branch `feat/tree-limits` (finos/vuu) covers much of the setup side. Its showcase
has TraderLimits examples, including an entity-limits page edited as a tree. The pieces to build on:

- `EditableTableContainer`, `EditableTableToolbar`, `TableEditorModeToggle`, `EditableTable` and
  `EditableTableFooter` (vuu-table-extras) for the setup grid and its view and edit modes
- `TableTreeCell` and parent-id trees in the array data source, for limits shown under Firm → desk → account
- `useConfirmSubmit` and `useConfirmDiscard` for the Save and Discard prompts
- `useCsvUpload` for template and limit import, and `useBulkEditDialog` for bulk edits
- `NextDayChanges` and `LimitsModule` in vuu-data-test for the data side


| Part | Component |
| --- | --- |
| Monitor, Breaches, Setup | Tabs in a vuu `Stack`, as in Orders and Fills |
| Toolbars | Salt `ToggleButtonGroup` (show, family, view, state, severity), Salt `Button`, Salt `Input` for the filter |
| Monitor grid | vuu `Table` with `groupBy` [desk, account]. Group rows aggregate utilisation with `high`. Custom cell renderers for utilisation and status. `rowClassNameGenerator` for hard-breach and selected rows |
| Contributors, breach detail | vuu-ui-controls `SplitPane` (column in the monitor, row in breaches). Contributors is a vuu `Table` filtered to the selected limit |
| Setup grid, Tree view | vuu `Table` over a parent-id tree (`tree: { parentColumn }`), `TableTreeCell` in the Entity column, as the `EntityLimitsPage` on `feat/tree-limits`. Rows are Firm, desks, accounts, and RIC carve-outs under an account. Each limit is a column with the entity's own value and a hidden effective column; an inherited value shows in italics. Order limits and order rate override (the nearest value applies); gross position, net delta and daily loss are caps (a child can only go lower). Warn %, hard %, period and owner are in a details popover and in List view. Tree \| List toggles between this and the flat grid; the edit session is shared |
| Setup grid, read-only | vuu `Table`, plain text cells. Toolbar has Edit limits, and Review changes for a supervisor. Rows in a pending change set show the old value struck through and are locked until the set is approved, rejected or withdrawn |
| Setup grid, edit session | Decided: the edit session pattern (bulk edit, as `VP_BULK_EDIT_*`). Edit limits makes the `Table` editable. Each editable cell shows its control all the time: `InputCell` (Salt `Input`) for Warn %, Limit and Hard %, `DropdownCell` for Period, and a ComboBox cell for Owner. A focused cell gets a solid 2px border; Enter or typing starts editing, shown by a dotted border (`InputCell.css`). A cell edited in the session gets vuu's vertical bar on its left. A validation error shows a red outline and icon and turns Save off. Delete marks a row for removal. Pending, temporary and kill-switch rows stay read-only. Discard drops the session; leaving the tab with changes asks to save or discard |
| Templates | A named set of limits (metric, scope, period, warn, limit, hard), with no entity. Edited in its own edit session and saved directly, since saving applies nothing. Applying is one-off: the differences go into a limits edit session and on for approval. Temporary and pending limits are skipped. The Used by list compares each account with the template. Import CSV uses `useCsvUpload` (row-level validation errors) |
| Save for approval | Salt `Dialog`: the session's changes as one change set, a required reason (`MultilineInput`) and the approver. The maker can't approve their own set |
| Kill switch | vuu-ui-controls `Prompt` (status error, focus on the safe button), as Cancel all |
| Increase, Add limit, Approve | Salt `Dialog` with `FormField`, `Input` (number shorthand), `Dropdown`, `ComboBox`, `DatePicker`, `Checkbox`, `MultilineInput` |
| Ticket | The existing ticket. The limit check replaces today's advisory warnings, and the Review step becomes the override step for a soft breach only |
