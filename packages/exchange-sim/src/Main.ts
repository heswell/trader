import {
  ConfigFactory,
  createConfiguredAuthProviders,
  createVuuServerApplication,
} from "@heswell/vuu-server";
import { loadExchangeSimConfig } from "./config";
import { createExchangeSimulator } from "./engine/ExchangeSimulator";
import { ExchangeModule } from "./modules/exchange/ExchangeModule";

/** Stand-alone exchange simulator server (auth mode and ports come from application.conf). */
export default async function main() {
  const config = ConfigFactory.load();
  const sim = createExchangeSimulator({
    config: loadExchangeSimConfig(config),
  });
  const application = createVuuServerApplication({
    authProviders: createConfiguredAuthProviders(config),
    config,
    defaultHttpsPort: 8446,
    defaultWebSocketPath: "/websocket-exchange-sim",
    defaultWebSocketPort: 8094,
    modules: [ExchangeModule(sim)],
  });
  await application.start();
  return { application, sim };
}
