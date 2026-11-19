# Watchlists and column sets: design spec

These are the source files of the design canvas, kept with the code as the spec.

- Live canvas: https://claude.ai/artifact/4j7Zdx3DXQmqVEhJCP6tFa
- Plan: https://claude.ai/artifact/Lzx9JPCmxXS11kMibkLysx
- Built in stack #105 (phases 1–7). The code is now the source of truth; see the [instrument grid guide](../../components/instrument-grid.md#dialogs).

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

- **Also applied** (SetSwitch): until vuu-ui has controlled quick filter values (upstream U1), the grid reads the quick part of FilterBar's applied filter and carries values on hidden fields itself. Clearing a chip clears it from the grid's filter; the field's control keeps the value and applies it again on a set that shows it.
- **Quick filters tab** (SetEditor): until vuu-ui's ColumnPicker takes extra tabs (upstream U2), the tab sits beside vuu's picker in the grid's own Columns panel, on vuu's `ItemPicker`.
- **Keys**: Alt+A adds every match (Ctrl+A keeps selecting the search text); Enter, not Space, adds or removes the highlighted instrument, as the search is a text field.
- **Default sets**: Watchlist has exchange, sector and type as quick filters; Screening has sector, market cap, P/E and yield.
