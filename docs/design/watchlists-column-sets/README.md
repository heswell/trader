# Watchlists and column sets: design spec

These are the source files of the design canvas, kept with the code as the spec.

- Live canvas: https://claude.ai/artifact/4j7Zdx3DXQmqVEhJCP6tFa
- Plan: https://claude.ai/artifact/Lzx9JPCmxXS11kMibkLysx
- Built (stack #105). The code is now the source of truth; see the [instrument grid guide](../../components/instrument-grid.md#dialogs).

| Board | Shows |
| --- | --- |
| Main.dc.html | Light · New watchlist: search and pick |
| WatchlistFiltered.dc.html | Dark · filters set, Add all matches |
| WatchlistEmpty.dc.html | Light · empty watchlist and the scope menu |
| SetSwitch.dc.html | Light · switching sets swaps columns and quick filters |
| SetEditor.dc.html | Light · column picker with a Quick filters tab |
| SetSaveDark.dc.html | Dark · New column set dialog |
| ScopeCreate.dc.html | Light · New column set: Available in |
| ScopeTabs.dc.html | Light · shared and scoped tabs, last set per watchlist |
| ScopeDelete.dc.html | Dark · deleting a watchlist with its own column set |

`canvas.json` holds the board layout and the spec notes: the New watchlist dialog built on the instrument picker, column sets that carry their quick filter fields, and column set scope (all watchlists or one).

## Where the build differs

- **Also applied** (SetSwitch): built as designed on vuu-ui's controlled quick filter values (finos/vuu#2774). The grid holds the values, vuu applies the ones on hidden fields (`applyHiddenValues`), and clearing a chip clears the value everywhere. The chips sit under the filter bar, as vuu's FilterBar has no slot for them.
- **Quick filters tab** (SetEditor): vuu-ui's ColumnPicker still takes no extra tabs, so the grid composes its Columns panel from vuu's `TabbedConfigPanel` (finos/vuu#2773): vuu's column picker, then vuu's `ContextPanelColumnsPicker` for the quick filter fields.
- **Keys**: Alt+A adds every match (Ctrl+A keeps selecting the search text); Enter, not Space, adds or removes the highlighted instrument, as the search is a text field.
- **Default sets**: Watchlist has exchange, sector and type as quick filters; Screening has sector, market cap, P/E and yield.
