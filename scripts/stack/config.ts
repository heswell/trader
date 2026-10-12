/**
 * Ports / URLs of the run-all stack (`bun run start:all`). Every value can be
 * overridden with the env var named alongside it. Defaults avoid the ports a
 * stock vuu-websocket / vuu-ui checkout uses (5001, 5006, 8080, 8091, 8443) so
 * both can run side by side.
 */
const num = (name: string, fallback: number) => {
  const value = process.env[name];
  return value ? Number(value) : fallback;
};

export const stackConfig = () => {
  const host = process.env.TRADER_HOSTNAME ?? "localhost";
  const keycloakPort = num("TRADER_KEYCLOAK_PORT", 8180);
  const hostPort = num("TRADER_HOST_PORT", 5100);
  const featuresPort = num("TRADER_FEATURES_PORT", 5110);
  return {
    host,
    keycloakPort,
    /** Keycloak's plain-http listener (dev mode always opens one). */
    keycloakHttpPort: num("TRADER_KEYCLOAK_HTTP_PORT", 8181),
    keycloakManagementPort: num("TRADER_KEYCLOAK_MGMT_PORT", 9100),
    keycloakUrl:
      process.env.TRADER_KEYCLOAK_URL ?? `https://${host}:${keycloakPort}`,
    keycloakRealm: "vuu",
    portalWsPort: num("TRADER_PORTAL_WS_PORT", 8191),
    portalHttpsPort: num("TRADER_PORTAL_HTTPS_PORT", 8543),
    hostPort,
    hostOrigin: `http://${host}:${hostPort}`,
    featuresPort,
    featuresOrigin:
      process.env.TRADER_FEATURES_ORIGIN ?? `http://${host}:${featuresPort}`,
  };
};

export type StackConfig = ReturnType<typeof stackConfig>;
