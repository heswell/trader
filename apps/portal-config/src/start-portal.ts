/**
 * vuu-portal (module discovery + auth, configured by ../application.conf) with the
 * EXCHANGE (exchange-sim) and OMS modules added to the same server.
 *
 * The stock vuu-portal registry does not tell remotes which Vuu server to talk to
 * (see docs/upstream-issues.md #1), so remotes use the portal connection and the
 * trading tables must live in the portal server for now.
 */
import { useConfigFile } from "./portal-server";

useConfigFile();

const {
  ConfigFactory,
  createConfiguredAuthProviders,
  createVuuServerApplication,
} = await import("@heswell/vuu-server");
const { createModuleRegistry } = await import(
  "@heswell/vuu-portal/src/ModuleRegistry"
);
const { loadModuleAdminRole, loadModuleState, ModuleDiscoveryModule } =
  await import(
    "@heswell/vuu-portal/src/modules/ModuleDiscovery/ModuleDiscoveryModule"
  );
const { createExchangeSimulator, ExchangeModule, loadExchangeSimConfig } =
  await import("@heswell/exchange-sim");
const { createOms, loadOmsConfig, OmsModule } = await import("@heswell/oms");

const config = ConfigFactory.load();
const sim = createExchangeSimulator({ config: loadExchangeSimConfig(config) });
const oms = createOms(sim.gateway, {
  config: loadOmsConfig(config),
  rics: () => sim.books.map((book) => book.ric),
});
const application = createVuuServerApplication({
  authProviders: createConfiguredAuthProviders(config),
  config,
  defaultHttpsPort: 8543,
  defaultWebSocketPath: "/websocket-portal",
  defaultWebSocketPort: 8191,
  loginSuccessProvider: (user, tableContainer) => ({
    moduleRegistry: createModuleRegistry(tableContainer, user),
  }),
  modules: [
    ModuleDiscoveryModule(loadModuleState(config), {
      adminRole: loadModuleAdminRole(config),
    }),
    ExchangeModule(sim),
    OmsModule(oms),
  ],
});

await application.start();
