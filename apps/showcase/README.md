# @heswell/trading-showcase

An rsbuild dev app that renders `@heswell/trading-ui` examples with no servers, using `@heswell/trading-test-data`
(the real exchange-sim and OMS engines in the browser).

```sh
bun run dev:showcase            # http://localhost:5001
bun run dev:trading-server      # optional: standalone EXCHANGE + OMS server for the "Remote server" toggle
```

- **Local test data** (default): the engines run in the page and tick live.
- **Remote server**: the app authenticates as `admin` and connects through the dev-server proxy:
  - `/remote/trading/authn` → `https://localhost:8447/api/authn`
  - `/remote/trading/ws` → `wss://localhost:8095/websocket-trading`

  Override the targets with `TRADING_REMOTE_AUTH`, `TRADING_REMOTE_WS` and `TRADING_REMOTE_WS_PATH`.

To add an example, see [docs/ui-guide.md §7](../../docs/ui-guide.md#7-showcase): add
`src/examples/<Component>Examples.tsx` and register it in `src/examples/index.ts`.

`bun run --filter @heswell/trading-showcase build` produces a static build in `dist/`.
