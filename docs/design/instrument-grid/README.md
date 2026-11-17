# Instrument Grid redesign: design spec

These are the source files of the design canvas, kept with the code as the spec for the redesign.

- Live canvas (interactive boards, light and dark): https://claude.ai/artifact/YZNNasvzknSnRH3BEgBuE3
- Implementation plan: https://claude.ai/artifact/WRKNzCxB7WhVXGHTDXfRj7

| Board | Shows |
| --- | --- |
| FbQuick.dc.html | Light: FilterBar quick filters |
| FbSaved.dc.html | Light: FilterBar saved filter pills |
| FbMenu.dc.html | Light: panel settings menu (show or hide the filter bar and footer) |
| FbQuickDark.dc.html | Dark: quick filters, link menu open on BP.L |
| FbSavedDark.dc.html | Dark: saved filter pills |
| FbHidden.dc.html | Dark: filter bar hidden, filters still applied |

`canvas.json` holds the board layout and the two spec notes: the FilterBar decisions and the link column spec.
