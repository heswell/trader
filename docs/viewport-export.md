# Viewport export (prototype)

Export the whole of a viewport (every row in its current sort and filter, not just the rendered range) to a CSV file. The values are formatted the way the grid shows them. The export is streamed end to end.

Status: prototype. The server part is on `heswell/vuu-websocket` branch `feat/viewport-export`. The client part is in this repo (`packages/trading-ui/src/export`) and is meant to move to `@vuu-ui/vuu-table-extras`. Anand's `csv-export-*` branches, which pull 1,000-row chunks through a viewport range with a 10k cap, are deliberately not used.

## Flow

```
client (browser)                                    vuu-server
────────────────                                    ──────────
click Export
  showSaveFilePicker()  ── must run inside the click, before any await
  RPC_REQUEST EXPORT_VIEWPORT {columns}  ── ws ──▶  ViewportContainer.handleRpcRequest
                                                      viewport.flush()
                                                      rows[pos] = table.rows[engine.rowIndexAt(pos)]
                                                      ⇒ snapshot (row refs), id = randomUUID
                        ◀── ws ── {exportId, path, url, rowCount, columns}
  fetch(url)            ─────────── http ───────▶  GET /api/export/<id>  (RestServer)
                                                      claim id (one time)
                        ◀── NDJSON, chunked ──────    ReadableStream pull():
                                                        await setImmediate()
                                                        serialise 2,000 rows
  body
   .pipeThrough(TextDecoderStream)
   .pipeThrough(ndjsonRows())         line → JSON array
   .pipeThrough(csvFormatter(cols))   value → grid text, CSV escape
   .pipeThrough(TextEncoderStream)
   .pipeTo(fileHandle.createWritable())             release snapshot on close / cancel / TTL
```

### Server (`vuu-server`)

- **`EXPORT_VIEWPORT` RPC.** `ViewportContainer.handleRpcRequest` handles it before the table's own RPC service, so every table gets it. It is resolved through `getViewportForSession`, so a session can only export its own viewports.
- **Snapshot** (`viewport/export/ViewportExports.ts`):
  - `viewport.flush()` first. This applies pending table changes and publishes them to the client as usual.
  - Then one pass over `engine.rowIndexAt(pos)`, copying references to the table's row arrays.
  - The engine index already has the sort, the client filter, the base filter, the link filter and the **permission filter** applied. So the export is exactly the rows the user can see, in the order they see them.
  - Columns must be a subset of the viewport's columns, so an export never reveals more than the subscription does.
- **Rows are not copied.** That is safe because table rows are replaced, not mutated:
  - `Table.update` stores the new array.
  - `updateByKey` slices.
  - `JoinTable` builds a new joined row.
  - Every trader publisher (`RowLayout.row()`, bars, depth, prices, OMS `TableSink.updateByKey`) writes a fresh array.

  A row deleted after the snapshot (the trades ring evicting) is still exported, because the snapshot holds the array. A row updated after the snapshot is exported with its old values. See the snapshot test in `__tests__/ViewportExport.test.ts`.
- **HTTP** (`viewport/export/ViewportExportHttpHandler.ts`):
  - `GET {vuu.export.path}/{id}` on the REST server, installed by `createVuuServerApplication` beside `/api/authn`. `composeHttpHandlers` already supports extra handlers; apps can also add routes through `additionalHttpHandlers`.
  - CORS uses the same allowed origins as auth.
  - The response is `application/x-ndjson`. The first line is the column names, then one JSON array per row. Values are raw; bigints are converted as `toProtocolValue` does.
- **Pull-based stream.**
  - `highWaterMark: 1`, so the client's reads drive serialisation.
  - Each `pull` yields to the event loop (`setImmediate`) and then serialises `vuu.export.chunkRows` (default 2,000) rows. A 60 ms send cycle, websocket frames and simulator timers are never stalled for longer than one chunk.
  - A slow client (slow disk) slows the export, not the server.
- **Limits.**
  - The id is claimed once: a second GET gets 404.
  - An unclaimed snapshot is released after 30 s.
  - A stream still running after 10 min is errored.
  - At most 2 snapshots per session.
  - `vuu.export.maxRows` (default 2M).
  - On completion, cancel (the client aborts and Bun cancels the stream) or timeout, the row references are dropped immediately.
- Config keys: `vuu.export.enabled` (default true), `vuu.export.path` (`/api/export`), `vuu.export.chunkRows`, `vuu.export.maxRows`.

### Client (`packages/trading-ui/src/export`)

- `csvStreams.ts` is generic, with no React or trading imports. It has `ndjsonRows()`, `csvFormatter(columns)` (RFC 4180, CRLF, optional UTF-8 BOM for Excel) and `csvField`.
- `exportColumns.ts` turns the grid's `ColumnDescriptor`s (the Table's current config: visible columns only, in display order, with labels) into `ExportColumn`s:
  1. If a **`CellTextFormatter`** is registered for the column's renderer (`type.renderer.name`), it is used. Custom renderers are React components, so an export can't run them; a renderer that wants to be exported as displayed supplies a text form.
  2. Otherwise vuu's `getValueFormatter(column)`, which is what the default cell renderer shows: mapped values, numeric decimals, rounding, `useLocaleString`, temporal patterns and time zone. Alignment padding is trimmed.

  The formatter is given the whole row by column name, because renderers read sibling columns (Price reads `ric` for the instrument's tick, Pnl reads `currency`). So the export fetches all of the data source's columns, not just the visible ones.
- `tradingTextFormatters(lookup)` holds the text forms of the trading cell renderers (Price, Side, Time, Pnl, …), kept beside them. `TradingRenderer` moved to `rendererNames.ts` so this has no React dependency.
- `exportViewport.ts`:
  - `pickExportSink()` uses `showSaveFilePicker()` → `createWritable()`. `pipeTo` closes it. Note the `createWriteable` typo and the extra `stream.close()` after `pipeTo` in the original experiment.
  - Without `showSaveFilePicker`, it falls back to an in-memory Blob download.
  - `exportViewportToCsv({dataSource, columns, sink, baseUrl, signal, onProgress})` does the RPC, the fetch and the pipeline. Abort cancels the fetch, and with it the server stream.
- Showcase: `#trades-export-csv` (remote data only). It shows a trades grid with a filter box and sortable columns; Export writes what the grid shows.

## Why not the websocket

1. **Head-of-line blocking.** A websocket is one ordered byte stream. Any export frame queued ahead of a price tick delays the tick until the whole frame has been written and read. The client has to parse each frame (one `JSON.parse` of the whole message) before it sees the next one.
2. **The outbound queue is built for state, not for bulk.** `OutboundRowPublishQueue` merges updates per viewport row index, keeping only the latest. That is right for a live window and wrong for an export, where every row must arrive exactly once. Pushing export rows through it would mean either a second queue with its own priority rules, or giant frames.
3. **A viewport range is not a snapshot.** Exporting by widening the range, as the `csv-export-*` branches do, returns a *live* window. While the client pages through it, rows insert, delete and move, so pages overlap or miss rows. In the ws-range run below, a 500,000-row viewport took 500,124 distinct row keys and 8 minutes to "complete", because the ring kept evicting and inserting under it.
4. **Backpressure.** HTTP streams give per-request flow control for free: the server serialises only when the client reads. Over the websocket, the session's own flow control would have to throttle export traffic separately from ticks.
5. **Measured**: see ws-range below.

HTTP needs no new framing, can go to a different host or worker later, and the browser writes it to disk without ever holding the file.

## Measurements

`bun ./packages/perf/src/export-load.ts --rows=500000 --baseline=20 --settle=20 --exports=3 --mode=both` (2026-11-13; macOS, 8 CPUs, Bun 1.3.14).

The machine was shared: a JVM Vuu server held about one core, another session ran `tsc`, and the load average was 6–9. Absolute numbers are noisy; the comparisons hold.

Setup:
- Perf trading server, tick ×4, about 7,600 trades/s.
- The `trades` ring at 500,000 rows, so it is constantly adding and evicting.
- 4 latency sessions, each watching newest-first trades and all prices.
- One exporter process. It exports a viewport sorted by `ric` A, `timestamp` D, with a filter, 7 columns, formatted with the trading text formatters, written to a CSV file.

**Export (client)**

| mode | rows | total s | wire MB | CSV MB | client peak RSS MB |
| --- | --- | --- | --- | --- | --- |
| http (parse + format + write) | 500,000 | 3.6–3.9 (1.6–2.6 on a quieter run) | 30.5 | 27.6 | 133–176 |
| http-raw (bytes only, no format) | 500,000 | 2.0–3.4 | 30.7 | – | 74–80 |
| ws-range (CHANGE_VP_RANGE 0..N, wait for every row) | 500,124 keys | **493** | **124** | – | 112 |

**Server**:
- The snapshot of 500k rows takes 3–11 ms. That is the one synchronous step: one pass over `rowIndexAt` plus `flush`.
- The stream is 250 chunks of 2,000 rows. Typical chunk 5–12 ms; the worst chunk in each export was 14–59 ms, most likely GC pauses.
- Snapshot memory is a 500k-element array of references, about 4 MB. Its heap delta did not show above the noise of a 1.2–1.5 GB server heap.

**Latency on the other sessions** (e2e ms, p50 / p95 / p99):

| window | trades | prices | server loop lag p99 ms |
| --- | --- | --- | --- |
| baseline (20 s) | 72 / 110 / 181 | 68 / 101 / 178 | 134 |
| 3 × http export (11.7 s) | 79 / 132 / 186 | 71 / 126 / 180 | 139 |
| after (20 s) | 71 / 104 / 156 | 67 / 95 / 153 | 142 |
| 3 × http-raw export (9 s) | 76 / 161 / 192 | 70 / 150 / 185 | 151 |
| after (20 s) | 72 / 122 / 211 | 67 / 110 / 205 | 184 |
| ws-range export (494 s) | **245 / 387 / 501** | **242 / 383 / 500** | **1,081** |
| after (20 s) | 71 / 91 / 162 | 67 / 86 / 136 | 316 |

- **HTTP export.** Trade p95 on other sessions moved from about 110 to 130–160 ms while exports ran back to back (one export every ~3.7 s), p99 barely moved, and it recovered at once. Run back to back, an export costs roughly one CPU core of serialisation on the server. That is the cost to cap (global limit, time-budgeted chunks) if many users export at once.
- **Websocket-range export.** Every other session's p95 went from 110 to 387 ms for eight minutes. Event-loop lag went over a second and server heap grew from 1.2 to 3 GB. The websocket carried 4× the bytes (row updates plus re-sent rows as the live window churns).
- **The exporting session's own ticks** (trades on the same websocket as the exporter): p95 116–172 ms during an HTTP export and 87–176 ms in raw mode, against 429 ms with ws-range. Some of this is the exporting client's own CPU parsing and formatting on the thread that also reads the websocket. A browser would see the same, which is the argument for a Worker at larger sizes.

**Browser** (showcase `#trades-export-csv`, Chromium, `showSaveFilePicker` replaced with an OPFS file handle so no native dialog was needed; the writable is the same `FileSystemWritableFileStream`):
- A filtered export (`ric starts "A" and size >= 1000`, 4,022 rows) matched the grid exactly:
  - headers are the column labels;
  - time is `HH:mm:ss.SSS`;
  - Side is `Buy` / `Sell`;
  - prices are at the instrument's precision;
  - sizes are grouped (`"2,089"`, quoted);
  - rows are sorted by RIC, then time descending;
  - every row matches the filter;
  - the file starts with a UTF-8 BOM.
- The unfiltered ring (200,000 rows) produced 11.1 MB in 1.8 s.

Reproduce:
- `bun run perf:export --mode=both` (needs vuu-server with `feat/viewport-export`)
- `--table=bars` for the mostly static bars table;
- `--mode=http,http-raw` to skip the slow ws-range leg.

## Open questions

- **Snapshot of rows that are mutated in place.** The prototype relies on rows being replaced on update. `TableListener.onUpdate` documents that `previous` may be `row` when a caller mutated in place, so that is allowed today. Options:
  1. make "rows are immutable once inserted" a documented Table invariant (trader already complies);
  2. a per-table `copyOnExport` flag that slices each row into the snapshot (about 2× the memory of the values, plus an O(n) copy at snapshot time);
  3. a copy-on-write generation counter in `Table`, so only rows changed during the export are copied.

  Recommendation: option 1, with option 2 as an escape hatch.
- **Grouped viewports** are rejected for now. Possible exports:
  1. leaf rows in group order, every node expanded, with the group-by columns. This is usually what's wanted in a spreadsheet;
  2. the tree as displayed, group rows with aggregates included and collapsed nodes collapsed;
  3. both, as an option.

  All three need a small engine API in vuu-viewport (a `GroupTree` walk over all nodes) rather than `rowIndexAt` over the visible list. A snapshot of a tree also needs the aggregate values, which are computed and not in the table rows, so they would have to be copied.
- **Browsers without `showSaveFilePicker`** (Firefox, Safari):
  - The fallback buffers the CSV in memory as a Blob, about 28 MB for 500k trades rows, then downloads it. That is fine to a few hundred MB.
  - The streaming alternative is a service worker that answers a download URL with a `ReadableStream` fed over a `MessageChannel` (the StreamSaver approach). It streams to the Downloads folder on every browser, at the cost of a service worker.
  - Server-side formatting with a plain `Content-Disposition` link would lose the client formatters. Only the declarative part of column formatting could be reproduced on the server, not custom renderers.
- **Auth on the HTTP fetch.** Today the export id is the credential:
  - 122 random bits;
  - issued only to an authenticated websocket session, after that session's permission filter has been applied;
  - single use, unclaimed for at most 30 s;
  - delivered over the websocket, never in a page URL.

  The REST server requires TLS except in permissive mode. To harden it:
  1. require `Authorization: Bearer <vuu token>` on the GET and check it belongs to the user who made the snapshot. The client already holds the token from `/api/authn`; with Keycloak, check the access token;
  2. bind the id to the session id and require it as a header;
  3. keep the id out of access logs (send it as a header or POST body, not a path segment).

  Recommendation: option 1 when `vuu.auth.mode` is not permissive.
- **Local engine.** The showcase's local data (`@heswell/vuu-data-engine-local`) has no HTTP server and does not implement `EXPORT_VIEWPORT`. The same `ViewportExports.stream(id)` could be handed to the client through a `fetch` shim in the same thread, or transferred over the `MessagePort` (transferable streams: Chromium and Firefox, not Safari).
- **Client CPU.** Parsing and formatting 500k rows takes about 1.5–2.5 s of CPU on the thread that does it. In the browser that is the main thread, interleaved per chunk, so the UI stays responsive but its own ticks are delayed (see own-session latency below). Moving fetch → format into a Worker needs the formatters rebuilt there: column descriptors are serialisable and text formatters would be registered in the worker. Worth it above about 1M rows.
- **Server-wide limits.** The limit is per session (2). A global cap on concurrent exports, and a chunk size adapted to a time budget (say 4 ms) rather than a fixed row count, are not done.
- **Column-level permissions.** The export columns are limited to the viewport's columns. If vuu-server gains column permissions, the same check applies here automatically.
- **Selection only.** `{selectedOnly: true}` would snapshot `viewport.selectedKeys` in viewport order instead.
