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

Open an example with `#<id>` (e.g. http://localhost:5001/#primitives-status). Each group links to its guide in
[docs/components](../../docs/components/README.md), and the generated [API reference](../../docs/api/components.md)
lists the showcase ids of every component.

| Group | Guide |
| --- | --- |
| InstrumentGrid | [instrument-grid](../../docs/components/instrument-grid.md) |
| MarketDepth, PriceLadder | [market-depth-and-ladder](../../docs/components/market-depth-and-ladder.md) |
| OrderTicket | [order-ticket](../../docs/components/order-ticket.md) |
| OrderBlotter, FillsBlotter, TradeTape, PositionsView | [blotters](../../docs/components/blotters.md) |
| Notifications | [notifications-and-connection](../../docs/components/notifications-and-connection.md) |
| Linking, Selectors | [selection-and-linking](../../docs/components/selection-and-linking.md) |
| Primitives, SideLabel | [primitives](../../docs/components/primitives.md) |
| Hosting | [hosting](../../docs/components/hosting.md) |
| Stack, Workspace | [components](../../docs/components/README.md) (composite screens) |

To add an example, see [docs/ui-guide.md §7](../../docs/ui-guide.md#7-showcase): add
`src/examples/<Component>Examples.tsx` and register it in `src/examples/index.ts`. A new
group (or a new reusable component) also needs a guide entry in `src/examples/docs.ts`; `bun run docs:check` fails
without one.

`bun run --filter @heswell/trading-showcase build` produces a static build in `dist/`.
