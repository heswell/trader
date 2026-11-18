# Orders and Fills redesign: design spec

These are the source files of the design canvas, kept with the code as the spec.

- Live canvas: https://claude.ai/artifact/Y4FG4GNu38vsvRji4VvCap
- Implementation plan: https://claude.ai/artifact/8E4Jhe3KQP4mxUZMu6GRgs

| Board | Shows |
| --- | --- |
| Main.dc.html | Orders · stacked panel, light (link after tabs, Salt toolbar, SplitPane) |
| OrdersNarrow.dc.html | Orders · narrow stack (560px), no wrapping |
| CancelAll.dc.html | Cancel all · confirmation prompt |
| Standalone.dc.html | Orders · standalone panel (link in header bar) |
| Fills.dc.html | Fills · stacked panel, link menu open |
| OrdersDark.dc.html | Orders · dark |
| PublisherMark.dc.html | Link button · publisher vs consumer (options) |
| LinkColA.dc.html | Experiment A · link column (as instrument grid), menu open on O-129 |
| LinkColB.dc.html | Experiment B · channel stripe + hover link action + linked footer |
| OrdersLinked.dc.html | Orders · display-only channel stripes, no link button |
| FillsLinked.dc.html | Fills · BARC.L chip pressed: filtered to the Red instrument |

`canvas.json` holds the board layout and three section headings (header, toolbar and split; the per-row channel link experiment; display-only links set from the watchlist).
