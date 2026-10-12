/**
 * vuu-portal (module discovery + auth, configured by ../application.conf).
 * The trading tables live in a separate Vuu server (start-trading.ts): each
 * trading remote names it in its config.json.
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

const config = ConfigFactory.load();
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
  ],
});

await application.start();
