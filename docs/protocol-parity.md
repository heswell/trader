# Vuu protocol parity matrix (P0.1)

Compares the Vuu WebSocket protocol used by the vuu-ui client with the TypeScript/Bun server in `heswell/vuu-websocket`. It also maps trading UI features to protocol requirements and recommends an order-entry pattern.

## Sources and references

| Prefix | Repo @ commit | Notes |
|---|---|---|
| `PT:` | `finos/vuu` `ui-portal-latest` @ `fb54f3431`: `vuu-ui/packages/vuu-protocol-types/index.d.ts` | Matches the published `@vuu-ui/*@4.0.0-alpha.20` that vuu-websocket depends on. The `heswell/vuu` checkout is stale (`0.11.2`, Jun 2025) and is ignored. |
| `UI:` | same, `vuu-ui/packages/` | Client: `vuu-data-remote/src/server-proxy/server-proxy.ts` (`SP`), `vuu-data-remote/src/VuuDataSource.ts` (`VDS`) |
| `VS:` | `heswell/vuu-websocket` `main` @ `b6e32b4`: `packages/vuu-server/src/` | Server. `CSA` = `core/CoreServerApiHandler.ts`, `VPC` = `viewport/ViewportContainer.ts`, `VP` = `viewport/Viewport.ts` |
| `LE:` | same repo, `packages/vuu-data-engine-local/src/` | In-browser engine for showcase and tests (P3.1) |

Status key: ✅ Supported · 🟡 Partial · ❌ Missing · 💤 Commented out · ➖ N/A (not used by client)

Note: the old `VP_EDIT_*` message family (`VP_EDIT_CELL_RPC` and others) no longer exists in `PT:`. No matches in `UI:` or `VS:`. Editing now uses `RPC_REQUEST` with named `rpcName`s (see §1.6).

## 1. Message matrix

### 1.1 Session, auth and heartbeat

| Client → server | Server reply | Status | Server evidence | Client evidence / notes |
|---|---|---|---|---|
| `LOGIN {token}` | `LOGIN_SUCCESS {vuuServerId, moduleRegistry?}` | ✅ | `VS:net/RequestProcessor.ts:55-70`; `net/LoginSuccess.ts:33` | `UI:SP:220`. If the token is rejected, the server sends the plain-text string `Invalid token` and closes the socket. The client maps this to `LOGIN_REJECTED` (`UI:vuu-data-remote/src/WebSocketConnection.ts:34,63-71,258`). |
| `AUTH` | – | ➖ | not handled | Defined at `PT:35` but never sent by `UI:`. Auth runs over HTTP. |
| – (server initiated) | `HB {ts}` | ✅ | `VS:net/ClientConnectionCreator.ts:145-156`; `net/flowcontrol/FlowController.ts:58-68` (also disconnects idle sessions) | `UI:SP:919-923` |
| `HB_RESP` | – | ✅ | `CSA:90-92` (no-op; feeds flow control) | |

### 1.2 Table metadata

| Client → server | Server reply | Status | Server evidence | Notes |
|---|---|---|---|---|
| `GET_TABLE_LIST` | `TABLE_LIST_RESP` | ✅ | `CSA:95`; session tables excluded at `core/table/TableContainer.ts:25` | |
| `GET_TABLE_META` | `TABLE_META_RESP` | ✅ | `CSA:93` | Session tables resolve too (`TableContainer.getTable`). An unknown table throws inside `getTable` before the reply is built, so `ERROR` is never sent (see §1.9). |

### 1.3 Viewport lifecycle and range

| Client → server | Server reply | Status | Server evidence | Notes |
|---|---|---|---|---|
| `CREATE_VP` (columns, range, sort, filterSpec, groupBy, aggregations) | `CREATE_VP_SUCCESS` + initial `TABLE_ROW`s | ✅ | `CSA:97`; `VPC:90-144` | 🟡 `CREATE_VP_REJECT` (`CSA:220-226`) is unreachable for an unknown table, because `getTable` throws first (see §1.9). |
| `CHANGE_VP_RANGE` | `CHANGE_VP_RANGE_SUCCESS` | ✅ | `CSA:103`; `VPC:146` | `CHANGE_VP_RANGE_REJECT` is never sent. Failures return a generic `ERROR` (`CSA:62`). |
| `CHANGE_VP` (sort / filter / groupBy / aggregations / columns) | `CHANGE_VP_SUCCESS` | ✅ | `CSA:107`; `VP:444-461` → `@heswell/vuu-viewport` `setConfig` | Failures return `ERROR`, not a reject message. |
| `DISABLE_VP` / `ENABLE_VP` | `DISABLE_VP_SUCCESS` / `ENABLE_VP_SUCCESS` | ✅ | `CSA:111-114`; `VPC:212-233`; output suppressed while disabled (`VP:564`), range resent on enable (`VP:350-357`) | Failures return `ERROR`, not `*_REJECT`. |
| `REMOVE_VP` | `REMOVE_VP_SUCCESS` | ✅ | `CSA:109` | |
| `FREEZE_VP` / `UNFREEZE_VP` | `FREEZE_VP_SUCCESS` / `UNFREEZE_VP_SUCCESS` | ❌ | no `case` in `CSA:88-147`, so it falls to `default: throw` (`CSA:143-146`) | Sent by `UI:VDS:350,360` → `UI:vuu-data-remote/src/server-proxy/viewport.ts:712,722`. `LE:` implements freeze client-side with a `vuuCreatedTimestamp` filter (`LE:EngineDataSource.ts:997-1029`). |
| – | `TABLE_ROW` (`U`, `SIZE`) | ✅ | `VS:net/ClientConnectionCreator.ts:79-95` (`formatDataOutbound`); `net/row/RowUpdateType.ts` | The `D` update type is never emitted; removals arrive as size changes plus re-indexed rows. |

### 1.4 Grouping, aggregation and tree

| Feature | Status | Evidence | Notes |
|---|---|---|---|
| groupBy (multi-level) via `CREATE_VP` / `CHANGE_VP` | ✅ | `VP:444-461` → `@heswell/vuu-viewport` `GroupTree.ts` | |
| Aggregations Sum/Avg/Count/High/Low/Distinct (1–6) | ✅ | `vuu-viewport/src/GroupTree.ts:132-144` (incremental) | The protocol has no VWAP (weighted average) aggregation type. |
| `OPEN_TREE_NODE` / `CLOSE_TREE_NODE` | ✅ | `CSA:125-128`; `VPC:338-344`; `VP:463-469` | |

### 1.5 Selection

| Client → server | Status | Evidence | Notes |
|---|---|---|---|
| `SELECT_ROW` | 🟡 | `CSA:115`, catch at `CSA:413` | Errors are swallowed (`catch (e) {}`). No `SELECT_ROW_REJECT` is sent, so the client promise hangs. |
| `DESELECT_ROW` | 🟡 | `CSA:117` | No try/catch, so errors become an unhandled rejection and no reply is sent. |
| `SELECT_ROW_RANGE` | 🟡 | `CSA:123`, catch at `CSA:461` | Same issue as `SELECT_ROW`: the error is swallowed. |
| `SELECT_ALL` | ✅ | `CSA:119` | Has a reject path. |
| `DESELECT_ALL` | 🟡 | `CSA:121` | No try/catch. |
| Viewport selection model | ✅ | `VPC:264-320`; `VP:471-509` | |

### 1.6 RPC (service RPCs, edit sessions, session tables, typeahead)

| Request | Status | Server evidence | Client evidence / notes |
|---|---|---|---|
| `RPC_REQUEST` + `VIEWPORT_CONTEXT`, custom `rpcName` → `RPC_RESPONSE {result: SUCCESS_RESULT \| ERROR_RESULT}` | ✅ | `CSA:105,283-336`; `VPC:251-262`; `net/rpc/DefaultRpcHandler.ts:15-20` (`registerRpc`, async handlers allowed) | `UI:SP:683-708`, `UI:VDS:798`. The response `action` is always `{}` (`CSA:319`), so the server cannot return a `SHOW_NOTIFICATION_ACTION` with an RPC result. |
| `RPC_REQUEST` + `GLOBAL_CONTEXT` / `VIEWPORT_ROW_CONTEXT` | ❌ | rejected with `ERROR_RESULT` (`CSA:283-304`) | The client also throws (`UI:SP:705`), so every RPC must be scoped to a viewport. |
| `getUniqueFieldValues` / `getUniqueFieldValuesStartingWith` (typeahead) | 🟡 | `core/module/typeahead/ViewPortTypeaheadRpcHandler.ts:26,30` | Only on tables whose service is a `DefaultRpcHandler`. Tables without a service get `NoRpcHandler` (`api/ViewPortDef.ts:13-18`), whose `processRpcRequest` returns `ERROR_RESULT` (`net/rpc/RpcHandler.ts`), so filter suggestions fail. |
| `createSessionTable {copyOption: All\|Empty\|Selected}` | ✅ | `net/rpc/CreateSessionTableRpcHandler.ts:123-127`; `TableContainer.ts:39-51` | `UI:VDS:688`. Session tables are removed on disconnect (`CSA:552-556`; `TableContainer.ts:53-63`). |
| `beginEditSession {editSessionMode}` | ✅ | `CreateSessionTableRpcHandler.ts:123-127` | `UI:VDS:719`. The client hard-codes `'all-rows'` (`UI:VDS:724`), which copies the whole source table. This is a client issue (vuu-ui), not a server one. |
| `editCell {key,column,data}` | ✅ | `net/rpc/EditTableRpcHandler.ts:163-170` | Contains demo-specific validation (`lotSize > 1000`, `:26-31`). `UI:VDS:754`. |
| `addRow` / `deleteRow` / `deleteSelectedRows` / `undoRowChange` | ✅ | `EditTableRpcHandler.ts:163-170` | `UI:VDS:822,837,853,869`. Only valid on session tables. |
| `endEditSession {save, force}` | ✅ | `net/rpc/EndEditSessionRpcHandler.ts:22-48` | Optimistic concurrency (vuu-server 4.0.0) snapshots each source row at session copy and compares every column at save (`getStaleColumns` is overridable); the error is `stale update` with `vuuMsg` `stale:<key>:<cols>` per row (upstream issue 61, resolved). On save, changes are written directly to the source table (`applySessionSave :131-162`). `prepareSessionSave`, `applySessionSave` and `handleEndEditSession` are `protected`, so a module can override them to route changes to a business service. Client: `UI:VDS:766` (`StaleUpdateError`). |
| `submitForm` (used by `SessionEditingForm`) | ➖ | No server default. A module must register it (`registerRpc`). | `UI:vuu-data-react/src/session-editing-form/SessionEditingForm.tsx:257` |

### 1.7 Menus and menu RPCs

Menu RPCs are supported since vuu-server 3.3.0 (vuu-websocket#89, trader upstream issue 11). The rows below describe 3.3.0; the `CSA:` / `VPC:` line references elsewhere in this document are from the original `b6e32b4` survey.

| Message | Status | Server evidence | Client evidence / notes |
|---|---|---|---|
| `GET_VIEW_PORT_MENUS` → `VIEW_PORT_MENUS_RESP` | ✅ | `CSA:101`; `net/rpc/RpcHandler.ts:23-45` (`menuItems`, `menuMap`) | Requested automatically after `CREATE_VP` (`UI:SP:316`). Real modules advertise menus, e.g. `vuu-basket-trading` `BasketService.ts:45-46`, `vuu-demo` `OrdersService.ts:62-63` ("Cancel Order"), `InstrumentService.ts:38-40`. |
| `VIEW_PORT_MENUS_SELECT_RPC` (context `selected-rows`) → `VIEW_PORT_MENU_RESP` / `VIEW_PORT_MENU_REJ` | ✅ | `SelectionViewPortMenuItem(name, filter, handler, rpcName)`; the handler gets the `ViewPortSelection` and a `MenuRpcSession {sessionId, channelId, requestId, user, viewport}` and may be async. A missing item or a throwing handler replies `VIEW_PORT_MENU_REJ`. | Sent by `UI:vuu-data-react/src/hooks/useVuuMenuActions.tsx:430`; routed by `UI:SP:668`. The client ignores `VIEW_PORT_MENU_REJ` (upstream-issues 66). |
| `VIEW_PORT_MENU_TABLE_RPC` (context `grid`) | ✅ | `TableViewPortMenuItem(name, filter, handler, rpcName)`, handler `(session)` | `useVuuMenuActions.tsx:435` |
| `VIEW_PORT_MENU_ROW_RPC` (context `row`) | ✅ | `RowViewPortMenuItem(name, filter, handler, rpcName)`, handler `(rowKey, row, session)` | `useVuuMenuActions.tsx:425` |
| `VIEW_PORT_MENU_CELL_RPC` (context `cell`) | ✅ | `CellViewPortMenuItem(name, filter, handler, rpcName, field?)`, handler `(rowKey, field, value, session)` | `useVuuMenuActions.tsx:418` |
| Menu actions: `OPEN_DIALOG_ACTION` (+ session table) | ✅ server / 🟡 client | `OpenDialog(table, renderComponent)` (`viewport/ViewPortAction.ts`). | `UI:SP:1223` fetches table meta for session-table dialogs; `useVuuMenuActions.tsx:359-389,466` opens `SessionEditingForm`. The client only acts on session tables (upstream-issues 64). |
| `SHOW_NOTIFICATION_ACTION` / `CLOSE_DIALOG_ACTION` / `NO_ACTION` | ✅ server / 🟡 client | `ShowNotification(message, title?)`, `CloseDialog()`, `NoAction()`. | `PT:914,921,930,933`. The client always shows notifications as "success" toasts (upstream-issues 65) and ignores `CLOSE_DIALOG_ACTION` / `NO_ACTION` (upstream-issues 63). |

`LE:` supports both `rpcRequest` and `menuRpcCall` (`LE:ModuleDataSource.ts:302-348`; `LE:EngineDataSource.ts:980-993`), so menus work in showcase and against the server. Trader declares no server menus yet: admin and order actions are direct `RPC_REQUEST`s from custom affordances (grid toolbar / client-side context-menu items, blotter row buttons).

### 1.8 Visual links

| Message | Status | Server evidence | Notes |
|---|---|---|---|
| `GET_VP_VISUAL_LINKS` → `VP_VISUAL_LINKS_RESP` | ✅ | `CSA:99`; `VPC:351-374` (from `TableDef.links`, other viewports in the same session) | Requested after `CREATE_VP` (`UI:SP:312,328`); the client auto-creates a pending link (`UI:SP:1163`). |
| `CREATE_VISUAL_LINK` → `CREATE_VISUAL_LINK_SUCCESS` | ✅ | `CSA:129`; `VPC:322-336`; `VP:120-142` | The child is filtered to the parent-column values of the selected parent rows. With no parent selection, the child is unfiltered. Parent → child only. |
| `REMOVE_VISUAL_LINK` → `REMOVE_VISUAL_LINK_SUCCESS` | ✅ | `CSA:131`; `VPC:346` | |

### 1.9 Errors and robustness

| Behaviour | Status | Evidence |
|---|---|---|
| `ERROR {msg}` for handled failures | ✅ | `CSA:62`. The client only logs it (`UI:SP:1276`). |
| Unknown or unsupported message type | ❌ | `CSA:143-146` throws inside the async `process`. `RequestProcessor` returns the promise without `await` (`net/RequestProcessor.ts:72-76`), so its `try/catch` never sees the error. `ViewServerHandler.handle` (`:48-57`) and `net/ws/BunWebSocketConnectionHandler.ts:20-26` await it, so the error ends as an unhandled rejection. No reply is sent, and the client's pending request hangs. Applies to `FREEZE_VP` and `UNFREEZE_VP` (the four menu RPCs reply since vuu-server 3.3.0). |
| Exceptions in `CREATE_VP` (unknown table), `DESELECT_ROW` and `DESELECT_ALL` | ❌ | Same path; these handlers have no try/catch. |
| RPC handler exceptions | ✅ | Caught and returned as `ERROR_RESULT` (`CSA:283-336`). An unknown `rpcName` throws in `DefaultRpcHandler.ts:30` and becomes "Failed to process request". |
| Permission filtering on viewports | ✅ | `TableDef.permissionFunction` is applied at viewport create (`VPC:123-129`). Relevant for P2.7. |

## 2. Trading UI features → protocol requirements

B = blocker for the feature as specified in the plan. N = nice-to-have, or a workaround exists.

| Plan item | Required protocol features | Status | Gaps |
|---|---|---|---|
| **P2.2** Order RPCs (`createOrder`, `amendOrder`, `cancelOrder`, `cancelAll`) | `RPC_REQUEST` (viewport context) → `RPC_RESPONSE` with an `ERROR_RESULT` reject reason | ✅ | N2: no `GLOBAL_CONTEXT`, so the ticket must own a viewport. N3: no notification `action` on RPC responses. |
| **P2.7** Permissions | `permissionFunction` row filter | ✅ | – |
| **P3.2** Instrument grid | CREATE/CHANGE_VP, range, sort, filter, groupBy + aggregations, typeahead, selection, **server context menu** (Buy, Sell, Open depth, Add to watchlist) | 🟡 | **B1**: menu RPCs (`VIEW_PORT_MENU_ROW_RPC` and `VIEW_PORT_MENUS_SELECT_RPC`) are not dispatched. Workaround: client-side menu items calling a direct RPC or a local action. N4: typeahead needs a `DefaultRpcHandler` service on the table. Watchlists: session tables ✅, or user settings. |
| **P3.3** Sparkline | `TABLE_ROW` updates (client ring buffer) or a server string column | ✅ | – |
| **P3.4** Market depth | Visual link instruments→depth on `ric` (or `CHANGE_VP` filter), sort, range | ✅ | Own-order markers need a join table. That is server-side work, not a protocol gap. |
| **P3.5** Price ladder | Depth viewport (filter/link), range, high-rate `TABLE_ROW`; order actions through P2.2 RPCs | ✅ | Performance, not protocol. Cancel-at-level and drag-to-amend use direct RPCs. |
| **P3.6** Order ticket | Direct RPC (see §3); typeahead / instrument viewport for the picker; `prices` viewport for the live header | ✅ (direct RPC) | The session-table / `SessionEditingForm` variant depends on **B1** for the menu → `OPEN_DIALOG_ACTION` entry point. |
| **P3.7** Order blotter | Viewport + filter tabs (`CHANGE_VP`), selection (multi), cancel and amend RPCs, children via visual link or groupBy/tree, inline amend via edit session | 🟡 | **B2**: selection error paths hang, which matters for multi-select cancel. **B1** applies if cancel is a server menu (as `OrdersService` does today). Inline amend via `beginEditSession` works, but the client copies the whole table (`'all-rows'`, `UI:VDS:724`, a vuu-ui issue), and the OMS must override `applySessionSave` so amends go through the state machine instead of overwriting rows. N1: `FREEZE_VP` to pause the blotter. |
| **P3.8** Fills blotter | groupBy RIC/side + Sum aggregation; CSV export is client-side | ✅ | N: no VWAP aggregation type. Expose `avgPx`/`notional` columns, or a server-side summary table. |
| **P3.9** Time & sales | Viewport with link/filter on `ric`, sort by time desc, range | ✅ | N1: `FREEZE_VP` / `UNFREEZE_VP` (❌) for "pause tape". Workaround: client-side buffering. |
| **P3.10** Positions | groupBy + Sum aggregations, ticking join with `prices` | ✅ | N: no grand-total row in the protocol. Use groupBy on a constant column or compute totals client-side. |
| **P3.11** Cross-component linking | Visual links (one-way, selection driven), plus a client-side bus | ✅ | – |
| **P3.12** Notifications | `RPC_RESPONSE` results; `NOTIFICATIONS` table module (`core/module/notifications/NotificationModule.ts`); `HB` and connection status | ✅ | **B2**: a request without a reply hangs instead of surfacing an error. N3: `SHOW_NOTIFICATION_ACTION` on RPC responses. |

### Blockers

| ID | Blocker | Affects |
|---|---|---|
| ~~**B1**~~ | *Resolved: vuu-websocket#89; vuu-server 3.3.0 (see §1.7).* Menu RPCs: `VIEW_PORT_MENUS_SELECT_RPC` is commented out; `VIEW_PORT_MENU_TABLE_RPC`, `VIEW_PORT_MENU_ROW_RPC` and `VIEW_PORT_MENU_CELL_RPC` are unimplemented, with no handler function on those menu item types. The server advertises menus that cannot be invoked. | P3.2 context menu, P3.7 menu cancel, session-table order ticket |
| **B2** | Unsupported or failing requests get no reply (unhandled rejection, missing `*_REJECT` replies), so client promises hang | P3.7 selection / multi-cancel, P3.12 error UX, any `FREEZE_VP` call |

### Nice-to-haves

- **N1** `FREEZE_VP` / `UNFREEZE_VP` (blotter and tape pause). An optional issue draft is included below.
- **N2** `GLOBAL_CONTEXT` RPCs, so RPCs are not tied to a viewport (also needs a vuu-ui client change at `UI:SP:705`).
- **N3** Non-empty `action` on `RPC_RESPONSE` (`SHOW_NOTIFICATION_ACTION`).
- **N4** Default typeahead service for tables without a `ServiceFactory`.
- **N5** Move the demo-specific `lotSize` validation out of the generic `EditTableRpcHandler` (`:26-31`).
- **N6** (vuu-ui) `beginEditSession` should accept an `editSessionMode` instead of hard-coding `'all-rows'`.
- **N7** VWAP / weighted-average aggregation type (protocol change).

## 3. Order entry recommendation: **direct RPC**

Use direct `RPC_REQUEST`s (`createOrder`, `amendOrder`, `cancelOrder`, `cancelAll`) registered with `registerRpc` on the OMS order table's service. Call them through `dataSource.rpcRequest(...)` on a viewport the component already holds: the `parentOrders` blotter, or a tiny `range {0,0}` viewport owned by the ticket. Return `SUCCESS_RESULT` with `{orderId}`, or `ERROR_RESULT` with the reject reason.

| Criterion | Direct RPC | Edit session / session table |
|---|---|---|
| Works end to end today | ✅ `UI:VDS:798` → `UI:SP:683` → `CSA:283-336` → `DefaultRpcHandler.ts:15-34` (async handlers supported). Already used by `BasketService` (`createBasket`) and `BasketTradingService` (`sendToMarket`/`takeOffMarket`). | 🟡 RPCs work, but the standard UI entry point (menu → `OPEN_DIALOG_ACTION` → `SessionEditingForm`) is blocked by **B1** |
| Fits OMS semantics (PendingNew/PendingReplace, risk checks, reject reason) | ✅ One request returns ack or reject with `errorMessage` | ❌ `endEditSession` writes directly to the source table (`EndEditSessionRpcHandler.ts:131-162`). It must be overridden, and per-cell `editCell` round-trips do not map to an atomic order |
| Cost | One message | createSessionTable + N × editCell + submit/endEditSession, plus a session table per ticket |
| Works in showcase (`LE:`) | ✅ `LE:ModuleDataSource.ts:302-348` | ✅ (`LE:ModuleDataSource.ts:127-297`) |
| Ticket UX (client-side validation, nudge buttons, one-click from ladder) | ✅ Natural fit for a custom form | 🟡 `SessionEditingForm` is generic and validates on blur |

**Amend:** use `amendOrder` RPCs from the ticket in amend mode and from ladder drag. For blotter inline edit, optionally use an edit session where the OMS service overrides `applySessionSave` (protected) to turn the diffs into `amendOrder` calls. This works today, but use `createSessionDataSource('Selected')` rather than `beginEditSession`, which copies all rows (N6).

**Constraint:** RPCs need a `VIEWPORT_CONTEXT` on both client and server (N2), and the response `action` is always empty (N3). Drive toasts from `result`, plus fills from the `fills` / notifications tables.

## 4. Draft upstream issues for `heswell/vuu-websocket` (not filed)

### Issue 1 (B1): Implement viewport menu RPCs (`VIEW_PORT_MENUS_SELECT_RPC`, `VIEW_PORT_MENU_TABLE/ROW/CELL_RPC`)

*Resolved: fixed in vuu-websocket#89; vuu-server 3.3.0.*

**Body**

The server returns menus in `VIEW_PORT_MENUS_RESP`, so the vuu-ui client shows them in the context menu, but selecting an item never gets a response.

- The `VIEW_PORT_MENUS_SELECT_RPC` case is commented out in `packages/vuu-server/src/core/CoreServerApiHandler.ts:137-142`. The leftover `processViewPortMenuSelectionRpcCall` (`:533-550`) uses a stale signature (`requestId, body, session.enqueue`).
- `VIEW_PORT_MENU_TABLE_RPC`, `VIEW_PORT_MENU_ROW_RPC` and `VIEW_PORT_MENU_CELL_RPC` have no `case`. `TableViewPortMenuItem`, `RowViewPortMenuItem` and `CellViewPortMenuItem` (`viewport/ViewPortMenu.ts:79-119`) have no handler function. Only `SelectionViewPortMenuItem` has `func` (`:58-77`).
- These requests reach `default: throw` (`CoreServerApiHandler.ts:143-146`). As a result, the client promise from `useVuuMenuActions` → `menuRpcCall` never resolves.
- Existing modules (`vuu-basket-trading` `BasketService`, `vuu-demo` `OrdersService` "Cancel Order", `InstrumentService`) already declare selection menus.

**Proposal**
1. Restore `case "VIEW_PORT_MENUS_SELECT_RPC"` using the current request context. Call `ViewportContainer.callRpcSelection` (`viewport/ViewportContainer.ts:235-249`) and reply with `VIEW_PORT_MENU_RESP {action, rpcName, vpId}`.
2. Add `func` handlers to the table, row and cell menu item types, with signatures matching Scala Vuu:
   - table: `(vp, session) => ViewPortAction`
   - row: `(rowKey, row, vp, session)`
   - cell: `(rowKey, field, value, vp, session)`

   Add the matching `case`s and `ViewportContainer` dispatch.
3. Allow handlers to be `async` (await, as `RPC_REQUEST` already does).
4. On a missing item or handler error, reply with `VIEW_PORT_MENU_REJ {error, rpcName, vpId}`.
5. Add action factories for `SHOW_NOTIFICATION_ACTION` and `CLOSE_DIALOG_ACTION` alongside `NoAction` and `OpenDialogViewPortAction` (`viewport/ViewPortAction.ts`).
6. Add tests for each context, including `OPEN_DIALOG_ACTION` with a session table (the `SessionEditingForm` flow).

**Why:** this is required by the trading front end (heswell/trader) for server-defined grid context menus (Buy/Sell/Open depth) and blotter "Cancel order", and it unblocks the standard Vuu session-table dialog flow.

### Issue 2 (B2): Requests that fail or are unsupported get no reply; client promises hang

**Body**

In `CoreServerApiHandler.process`, an unsupported `body.type` throws (`core/CoreServerApiHandler.ts:143-146`). `RequestProcessor` does `return this.handleViewServerMessage(...)` inside `try` without `await` (`net/RequestProcessor.ts:72-76`), so the rejection is never caught there. It propagates out through `ViewServerHandler.handle` and the Bun `message` handler (`net/ws/BunWebSocketConnectionHandler.ts:20-26`) as an unhandled rejection, and nothing is sent to the client.

The same happens for exceptions in handlers that have no try/catch:

- `CREATE_VP` with an unknown table (`getTable` throws before `CREATE_VP_REJECT` at `:220-226` can be sent)
- `DESELECT_ROW`
- `DESELECT_ALL`

`SELECT_ROW` and `SELECT_ROW_RANGE` swallow errors with `catch (e) {}` and return nothing (`:413,461`). Other failures return a generic `ERROR` where the client expects a typed reject (`CHANGE_VP_RANGE_REJECT`, `*_REJECT` for selection, `DISABLE_VP_REJECT`, `ENABLE_VP_REJECT`).

**Proposal**
1. Use `return await` (or `.catch`) in `RequestProcessor` so async errors reach the existing handler. Reply with `ERROR` and do not close the channel for per-request failures.
2. Change `default` in `process` to reply with `ERROR {msg: "unsupported message type X"}` instead of throwing.
3. Wrap every handler and emit the typed reject the protocol defines. Fill `SELECT_ROW_REJECT` and `SELECT_ROW_RANGE_REJECT` in the empty catches.
4. Add tests that send an unknown type and a bad `vpId` for each message, and assert a reply is sent.

**Why:** the trading UI depends on predictable ack or reject for selection (multi-select cancel) and for error and stale-data UX.

### Issue 3 (optional, N1): Support `FREEZE_VP` / `UNFREEZE_VP`

**Body**

The vuu-ui `VuuDataSource.freeze()` and `unfreeze()` send `FREEZE_VP` and `UNFREEZE_VP` (`vuu-data-remote/src/VuuDataSource.ts:350,360`). `CoreServerApiHandler` has no case for them (`core/CoreServerApiHandler.ts:88-147`), so the request throws (see Issue 2).

The in-browser engine (`packages/vuu-data-engine-local/src/EngineDataSource.ts:997-1029`) implements freeze by filtering on `vuuCreatedTimestamp`. The server could do the same with a base filter on the viewport. It would reply with `FREEZE_VP_SUCCESS {viewPortId}` / `UNFREEZE_VP_SUCCESS`, or `*_REJECT` if the viewport is already frozen or not frozen.

**Why:** "pause" for the time & sales tape and the order blotter in the trading UI.
