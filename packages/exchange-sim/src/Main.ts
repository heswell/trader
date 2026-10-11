import { ConfigFactory, createVuuServerApplication } from "@heswell/vuu-server";
import { createConfiguredAuthProviders } from "@heswell/vuu-server";
import { HelloModule } from "./modules/hello/HelloModule";

/** Stand-alone exchange simulator server (auth mode and ports come from application.conf). */
export default async function main() {
  const config = ConfigFactory.load();
  const application = createVuuServerApplication({
    authProviders: createConfiguredAuthProviders(config),
    config,
    defaultHttpsPort: 8446,
    defaultWebSocketPath: "/websocket-exchange-sim",
    defaultWebSocketPort: 8094,
    modules: [HelloModule()],
  });
  await application.start();
}
