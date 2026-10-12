import { ensureLinkBusBroadcast } from "@heswell/trading-ui";
import { init } from "@module-federation/enhanced/runtime";
import {
  type AuthConfig,
  AuthenticationErrorBoundary,
  AuthenticationProvider,
  KeycloakAuthHandler,
} from "@vuu-ui/core";
import { ConnectionManager } from "@vuu-ui/vuu-data-remote";
import { PageVisibilityObserver } from "@vuu-ui/vuu-utils";
import { createRoot } from "react-dom/client";
import { App } from "./App";

import "@vuu-ui/vuu-icons/index.css";

init({ name: "host", remotes: [] });

// One BroadcastChannel link per window for the instrument link bus, so
// features popped out into their own windows stay linked (docs/ui-guide.md §5).
ensureLinkBusBroadcast();

new PageVisibilityObserver({
  onHidden: () => ConnectionManager.disableActiveSubscriptions(),
  onVisible: () => ConnectionManager.enableActiveSubscriptions(),
});

// set by public/index.html from /config.json; vuu-utils types the global as
// VuuConfig, which lacks the Keycloak clientId/realm that AuthConfig carries
const config = (await vuuConfig) as unknown as AuthConfig;
const container = document.getElementById("root");
if (!container) throw Error("No react root defined in page");

createRoot(container).render(
  <AuthenticationErrorBoundary
    fallback={(error) => (
      <div role="alert">Unable to authenticate: {error.message}</div>
    )}
  >
    <AuthenticationProvider
      authConfig={config}
      authHandlerClass={KeycloakAuthHandler}
      mode="identity"
    >
      <App />
    </AuthenticationProvider>
  </AuthenticationErrorBoundary>,
);
