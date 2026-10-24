# Getting started: build your own trading app with these components

This guide puts the reusable components (`@heswell/trading-ui`) into an app of your own. You choose where the data
comes from:

1. **Remote mode.** Connect to a trading Vuu server: the stack's server, or the stand-alone EXCHANGE + OMS server.
2. **Engine-local mode.** Run the real exchange simulator and OMS in the page. No servers are needed.
3. **Portal feature.** Package a component as a vuu-portal module-federation feature, which inherits the
   portal's connection.

The component guides are in [components/](components/README.md), the generated reference in
[api/](api/README.md), and the runnable examples in the [showcase](../apps/showcase/README.md).

## 0. Set up the app

`@heswell/trading-ui` is a private workspace package. It ships TypeScript source (`main: src/index.ts`), not a
build. So, for now, an app that uses it lives in this monorepo:

1. Create `apps/<your-app>`.
2. Copy `apps/showcase` as the template. It has the rsbuild config, the CSS loader and the theme set-up.
3. Run `bun install`.

The app needs:

- **Dependencies.**
  - `@heswell/trading-ui` (`workspace:*`);
  - `@heswell/trading-test-data` (`workspace:*`), for engine-local mode only;
  - `@salt-ds/core` 1.67.0;
  - the `@vuu-ui/*` packages at `4.0.0-alpha.24`: `core`, `vuu-icons`, `vuu-theme`, `vuu-table-extras` and
    the others in [apps/showcase/package.json](../apps/showcase/package.json);
  - React 19.
- **Component CSS as strings.** trading-ui components `import css from "./X.css"` and inject it at runtime
  ([ui-guide §2](ui-guide.md#2-styling-css-injection-and-salt--vuu-theming)). Your bundler must load those
  imports as text:
  - with rsbuild, copy `apps/showcase/css-inline-loader.cjs` and the `tools.rspack` rule in
    `apps/showcase/rsbuild.config.ts`, which includes `packages/trading-ui/src`;
  - portal features use portal-build's `cssInline` option instead.
- **Theme and renderers.** Wrap the app in the Salt provider with the vuu theme. Import the vuu icon and theme
  CSS and `@vuu-ui/vuu-table-extras`, which registers cell renderers such as `vuu.price-move-background`:

```tsx
// src/index.tsx
import "@vuu-ui/vuu-icons/index.css";
import "@vuu-ui/vuu-theme/index.css";
import "@vuu-ui/vuu-table-extras";
import { SaltProviderNext } from "@salt-ds/core";
import { createRoot } from "react-dom/client";
import { App } from "./App";

createRoot(document.getElementById("root") as HTMLElement).render(
  <SaltProviderNext theme="vuu-theme" density="high" mode="light">
    <App />
  </SaltProviderNext>,
);
```

Every app also mounts the **host services** once, above the components ([hosting](components/hosting.md#host-services-mount-once)):

```tsx
// src/TradingHost.tsx
import {
  ConnectionBanner,
  OrderTicketLauncherProvider,
  TradingNotificationsProvider,
} from "@heswell/trading-ui";
import type { ReactNode } from "react";

export const TradingHost = ({ children }: { children: ReactNode }) => (
  // notificationsCenter: a stand-alone app has no vuu-portal toast centre
  <TradingNotificationsProvider notificationsCenter>
    <OrderTicketLauncherProvider>
      <ConnectionBanner />
      {children}
    </OrderTicketLauncherProvider>
  </TradingNotificationsProvider>
);
```

The screen used by both modes below:

```tsx
// src/TraderScreen.tsx
import { InstrumentGrid, OrderBlotter, PriceLadder } from "@heswell/trading-ui";

export const TraderScreen = () => (
  <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gridTemplateRows: "1fr 1fr", height: "100vh" }}>
    <InstrumentGrid />
    <PriceLadder style={{ gridRow: "span 2" }} />
    <OrderBlotter />
  </div>
);
```

The components share the default link group, so selecting a row in the grid drives the ladder
([selection and linking](components/selection-and-linking.md)). Clicking the ladder places orders
([market depth and ladder](components/market-depth-and-ladder.md)). The grid's Buy / Sell actions open the order ticket
through `OrderTicketLauncherProvider` ([order ticket](components/order-ticket.md)).

## 1. Remote mode (vuu-server)

Open a connection with `connectToVuuServer`, then render under `TradingDataProvider mode="remote"` with the same
`connectionId`:

```tsx
// src/App.tsx
import { connectToVuuServer, TradingDataProvider } from "@heswell/trading-ui";
import { useEffect, useState } from "react";
import { TraderScreen } from "./TraderScreen";
import { TradingHost } from "./TradingHost";

const CONNECTION_ID = "trading";

export const App = () => {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    connectToVuuServer({
      connectionId: CONNECTION_ID,
      websocketUrl: "ws://localhost:8095/websocket-trading",
      authUrl: "http://localhost:8447/api/authn",
      username: "alice",
    }).then(
      () => setReady(true),
      (err) => setError(String(err)),
    );
  }, []);
  if (error) return <p>{error}</p>;
  if (!ready) return <p>Connecting…</p>;
  return (
    <TradingDataProvider mode="remote" connectionId={CONNECTION_ID}>
      <TradingHost>
        <TraderScreen />
      </TradingHost>
    </TradingDataProvider>
  );
};
```

- **The server.**
  - `bun run dev:trading-server` starts the stand-alone EXCHANGE + OMS server on
    `ws://localhost:8095/websocket-trading` and `http://localhost:8447/api/authn`.
  - It uses permissive auth, so no password is needed and any user name works. OMS permissions still apply: the
    seeded owners are alice, bob, carol, dave and erin.
  - Its conf allows CORS only from the showcase origins (`http://localhost:5001`, `http://127.0.0.1:5001`). Serve
    your app from one of those, or add your origin to `vuu.auth.cors.allowedOrigins`
    ([OMS README](../packages/oms/README.md)).
- **Reconnects.** `connectToVuuServer` resolves after the first login. The connection is then supervised: on a
  drop it reconnects with backoff, logs in again and resubscribes ([resilience.md](resilience.md)).
  - `ConnectionBanner`, `ConnectionStatusIndicator` and the stale indicators show the state.
  - `disconnectFromVuuServer(connectionId)` closes the connection.
- **Keycloak.** The stack's trading server (`:8192` / `:8544`) authenticates with Keycloak. A stand-alone app
  would need a portal token for its REST login, so against the full stack, host the components as portal
  features instead (section 3).

## 2. Engine-local mode (no servers)

`@heswell/trading-test-data` runs the real exchange-sim and OMS engines in the page on engine-local, with the same
tables, RPCs, validation and per-user filtering as the server ([architecture: engine-local mode](architecture.md#6-engine-local-mode)):

```tsx
// src/App.tsx
import { setCurrentUser } from "@heswell/trading-test-data";
import { createTradingLocalServer } from "@heswell/trading-test-data/react";
import { TradingDataProvider } from "@heswell/trading-ui";
import { TraderScreen } from "./TraderScreen";
import { TradingHost } from "./TradingHost";

// The engine-local user drives OMS permissions: alice sees and trades ACC-US-01;
// "admin" sees every account.
setCurrentUser({ name: "alice", authorizations: [] });
const localServer = createTradingLocalServer(); // shared, ticking singleton

export const App = () => (
  <TradingDataProvider mode="local" localServer={localServer}>
    <TradingHost>
      <TraderScreen />
    </TradingHost>
  </TradingDataProvider>
);
```

- The engines start ticking on the first subscription. `getTradingTestData({ exchange: { activeInstruments } })`
  tunes the market; pass it as `createTradingLocalServer(getTradingTestData(options))`.
- For deterministic tests, use `createTradingTestData({ seed, manualClock: true })` and `advance(ms)`
  ([trading-test-data README](../packages/trading-test-data/README.md#use)).
- It is a dev and test dependency: the bundle contains both engines. Use it for demos, tests and prototypes, and
  never import it from reusable components.

Switching modes needs only a different `TradingDataProvider`. The components and host services stay the same, as
the showcase's "Local test data / Remote server" toggle shows ([apps/showcase](../apps/showcase/README.md)).

## 3. As a vuu-portal feature

Inside vuu-portal, the host provides the data connection. A feature wraps its component in `TradingFeatureRoot`,
which mounts the host services once per window and inherits the portal's `DataProvider`:

```tsx
import { OrderBlotter, TradingFeatureRoot } from "@heswell/trading-ui";
import { useVuuAuthorizations } from "@vuu-ui/core";

// The roles of the trading session; the OMS enforces the same roles on every RPC.
const Orders = () => (
  <OrderBlotter readOnly={!useVuuAuthorizations().includes("trading-execute")} />
);

export const OrdersFeature = () => (
  <TradingFeatureRoot>
    <Orders />
  </TradingFeatureRoot>
);
```

To add the feature to the portal:

1. Add an entry to `apps/features/trading/src/catalog.ts`.
2. Run `bun run features:sync` and `bun run build`.
3. `bun run start:all` serves it.

See [ui-guide §10](ui-guide.md#10-packaging-a-component-as-an-mf-feature-appsfeaturestrading),
[portal-integration.md](portal-integration.md) and [hosting: TradingFeatureRoot](components/hosting.md#tradingfeatureroot).

## Next steps

- **Roles.** Gate trading entry points by role with `readOnly`, `launchOrderTicket` and module roles
  ([permissions](components/README.md#permissions)).
- **Theming.** Restyle with the `--trading-*` tokens and component class names
  ([theming](components/README.md#theming-and-css-hooks)).
- **Running the full stack.** [operations.md](operations.md).
