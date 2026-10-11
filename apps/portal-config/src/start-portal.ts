/**
 * vuu-portal (module discovery + auth, configured by ../application.conf) with the
 * exchange-sim modules added to the same server.
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

const config = ConfigFactory.load();
const sim = createExchangeSimulator({ config: loadExchangeSimConfig(config) });
const application = createVuuServerApplication({
  authProviders: createConfiguredAuthProviders(config),
  config,
  defaultHttpsPort: 8443,
  defaultWebSocketPath: "/websocket-portal",
  defaultWebSocketPort: 8091,
  loginSuccessProvider: (user, tableContainer) => ({
    moduleRegistry: createModuleRegistry(tableContainer, user),
  }),
  modules: [
    ModuleDiscoveryModule(loadModuleState(config), {
      adminRole: loadModuleAdminRole(config),
    }),
    ExchangeModule(sim),
  ],
});

await application.start();
