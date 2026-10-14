# @heswell/trading-showcase

An rsbuild dev app that renders `@heswell/trading-ui` examples with no servers, using `@heswell/trading-test-data`
(the real exchange-sim and OMS engines in the browser).

```sh
bun run dev:showcase            # http://localhost:5001
bun run dev:trading-server      # optional: standalone EXCHANGE + OMS server for the "Remote server" toggle
```

- **Local test data** (default): the engines run in the page and tick live.
- **Remote server**: the app authenticates as `admin` (no password; permissive auth) and connects directly to
  `http://localhost:8447/api/authn` and `ws://localhost:8095/websocket-trading`. The server's conf lists
  `http://localhost:5001` and `http://127.0.0.1:5001` in `vuu.auth.cors.allowedOrigins`. Override the targets with
  `TRADING_REMOTE_AUTH` and `TRADING_REMOTE_WS` (full URLs).

To add an example, see [docs/ui-guide.md §7](../../docs/ui-guide.md#7-showcase): add
`src/examples/<Component>Examples.tsx` and register it in `src/examples/index.ts`.

`bun run --filter @heswell/trading-showcase build` produces a static build in `dist/`.
