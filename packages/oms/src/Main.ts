import {
  type Config,
  ConfigFactory,
  createConfiguredAuthProviders,
  createVuuServerApplication,
  getLogger,
} from "@heswell/vuu-server";
import {
  createExchangeSimulator,
  ExchangeModule,
  loadExchangeSimConfig,
} from "@heswell/exchange-sim";
import { loadOmsConfig } from "./config";
import { createOms } from "./engine/OmsService";
import { OmsModule } from "./modules/oms/OmsModule";

/**
 * Stand-alone trading server: EXCHANGE + OMS in one VuuServer (auth mode and
 * ports come from application.conf).
 */
export default async function main(config: Config = ConfigFactory.load()) {
  const sim = createExchangeSimulator({
    config: loadExchangeSimConfig(config),
  });
  const oms = createOms(sim.gateway, {
    config: loadOmsConfig(config),
    rics: () => sim.books.map((book) => book.ric),
    logger: getLogger("trader.oms"),
  });
  const application = createVuuServerApplication({
    authProviders: createConfiguredAuthProviders(config),
    config,
    defaultHttpsPort: 8447,
    defaultWebSocketPath: "/websocket-trading",
    defaultWebSocketPort: 8095,
    // EXCHANGE first: the positionPrices join needs the prices table.
    modules: [ExchangeModule(sim), OmsModule(oms)],
  });
  await application.start();
  return { application, sim, oms };
}
