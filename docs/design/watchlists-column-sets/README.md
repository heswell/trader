# Watchlists and column sets: design spec

These are the source files of the design canvas, kept with the code as the spec.

- Live canvas: https://claude.ai/artifact/4j7Zdx3DXQmqVEhJCP6tFa

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
