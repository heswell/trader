# Design boards

Every design canvas made for trader, in one place. Each one is a live, interactive canvas on claude.ai. Its source
files (`*.dc.html` boards plus `canvas.json`) are copied into a folder here, so a session can read a design without
opening the canvas.

**Before designing anything, check this index for an existing board on the same area, and keep new designs
consistent with it.** Settled decisions live in the canvas notes and in each area's plan doc.

## Adding or updating a design

1. Make the canvas on claude.ai as usual.
2. Copy its `project/*` files into `docs/design/<slug>/` and add a `README.md` (see
   [instrument-grid](instrument-grid/README.md)).
3. Add a row to the right area below, with its status. Add a new area if none fits.
4. When a canvas changes, copy its files again. When its status changes, update the row.

Status: **Exploring** (options open), **Awaiting feedback**, **Approved** (ready to build), **Built** (shipped; the
boards are now history, the code is the source of truth), **Superseded**.

## Instruments and market data

| Design | Status | Canvas | Plan doc | Sources |
| --- | --- | --- | --- | --- |
| Instrument picker (title-bar ChannelPicker, search dropdown, completion row) | Built | [canvas](https://claude.ai/artifact/TFaxdKxftNLYz3Uj6Usa7h) | | [instrument-picker](instrument-picker/README.md) |
| Instrument grid redesign (link column, pinned rows, panel header, footer, row actions, light/dark) | Built (stack #84 in review) | [canvas](https://claude.ai/artifact/YZNNasvzknSnRH3BEgBuE3) | [plan](https://claude.ai/artifact/WRKNzCxB7WhVXGHTDXfRj7) | [instrument-grid](instrument-grid/README.md) |
| Watchlists and column sets (New Watchlist dialog, column sets carry quick filters, shared or scoped sets) | Built (stack #105 in review) | [canvas](https://claude.ai/artifact/4j7Zdx3DXQmqVEhJCP6tFa) | [plan](https://claude.ai/artifact/Lzx9JPCmxXS11kMibkLysx) | [watchlists-column-sets](watchlists-column-sets/README.md) |

## Screening and filters

| Design | Status | Canvas | Plan doc | Sources |
| --- | --- | --- | --- | --- |
| Instrument grid screening (fundamentals columns, column picker, column sets, number shorthand) | Approved (phase 3) | [canvas](https://claude.ai/artifact/5dRbmjsZ6jRji9Qy1YYSiS) | [plan](https://claude.ai/artifact/RjHPphHR6GfmN1QB6hZ4Uw) | [instrument-grid-screening](instrument-grid-screening/README.md) |
| Compact filter bar (vuu-ui FilterBar, used as-is by the grid) | Built upstream | [canvas](https://claude.ai/artifact/Lntwf5HRb97dvnzoTXv2gE) | | [compact-filter-bar](compact-filter-bar/README.md) |

## Order entry

| Design | Status | Canvas | Plan doc | Sources |
| --- | --- | --- | --- | --- |
| Order ticket review (keyboard-first critique of current ticket) | Built | [page](https://claude.ai/artifact/DJyPP6tkJUnPJUMHPtkAWY) | [plan](https://claude.ai/artifact/D8tjXywxUAy7i94uyHne4F) | [order-ticket-review](order-ticket-review/README.md) |
| Order ticket concept | Built | [page](https://claude.ai/artifact/MxNxyfCP55hoipn4bX9LHk) | [plan](https://claude.ai/artifact/D8tjXywxUAy7i94uyHne4F) | [order-ticket-concept](order-ticket-concept/README.md) |

## Orders, fills and blotters

| Design | Status | Canvas | Plan doc | Sources |
| --- | --- | --- | --- | --- |
| Order blotter depth panel | Built | [canvas](https://claude.ai/artifact/R6zWzirg6zec5uxBeTKEox) | | [order-blotter-depth](order-blotter-depth/README.md) |
| Orders and fills redesign (SplitPane, Salt toolbar, Cancel all, display-only channel bookends) | Approved | [canvas](https://claude.ai/artifact/Y4FG4GNu38vsvRji4VvCap) | [plan](https://claude.ai/artifact/8E4Jhe3KQP4mxUZMu6GRgs) | [orders-fills](orders-fills/README.md) |

## Other trader plans (no canvas)

[Futures support](https://claude.ai/artifact/HEZguaQG68ZTyAqPPvHDWb) ·
[Options support](https://claude.ai/artifact/SUtfdfaCPMKjkDDxrpYmWy) ·
[Showcase CLI refactor](https://claude.ai/artifact/Gbh1TPEaDdpzwLsdVPFsSu)

## Vuu portal designs (not trader)

Made in vuu sessions; listed so they are not mistaken for trader work or redesigned twice. Sources are not copied
here.

[Vuu Portal Home](https://claude.ai/artifact/Bf5rhBgQYKoVgzCvZ1yydX) ·
[Vuu Portal Explorer](https://claude.ai/artifact/9WCYJzn9moTQUAah1fyqi2) ·
[Notifications browser](https://claude.ai/artifact/1E4MadFetGEn8DbzYq6QRM) ·
[User Admin workflow](https://claude.ai/artifact/61CkHP7uvhcdATndEobrvz) ·
[Module config views](https://claude.ai/artifact/UUubF4dewaiHuZj4jTkdRs) ·
[Vuu Tables panel](https://claude.ai/artifact/P1rouqUszcgmwXb8LwD95r) ·
[Portal runtime configuration](https://claude.ai/artifact/HefbdzpSZXQREYYJTzYsa5) ·
[Table performance benchmarking](https://claude.ai/artifact/E6WRgh8c5uLQaNxmwC95rN)
