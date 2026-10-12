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
    /** The trading Vuu server (exchange-sim + OMS) the trading modules use. */
    tradingWsPort: num("TRADER_TRADING_WS_PORT", 8192),
    tradingHttpsPort: num("TRADER_TRADING_HTTPS_PORT", 8544),
    hostPort,
    hostOrigin: `http://${host}:${hostPort}`,
    featuresPort,
    featuresOrigin:
      process.env.TRADER_FEATURES_ORIGIN ?? `http://${host}:${featuresPort}`,
  };
};

export type StackConfig = ReturnType<typeof stackConfig>;

/** Keycloak confidential client of the trading Vuu server (owns the trading roles). */
export const TRADING_CLIENT_ID = "trader-trading-server";
export const TRADING_CONNECTION_ID = "trading";
export const TRADING_WEBSOCKET_PATH = "/websocket-trading";

/**
 * <mfUrl>/config.json of every trading remote (@vuu-ui/core RemoteModule,
 * alpha.21+): the Vuu server the module connects to. The portal user's
 * Keycloak token is exchanged for a Vuu token at restUrl. TRADER_TRADING_REST_URL
 * / TRADER_TRADING_WEBSOCKET_URL override the derived URLs (e.g. behind a proxy).
 */
export const featureConfigJson = (
  cfg: Pick<StackConfig, "host" | "tradingHttpsPort" | "tradingWsPort">,
) => ({
  connectionId: TRADING_CONNECTION_ID,
  restUrl:
    process.env.TRADER_TRADING_REST_URL ??
    `https://${cfg.host}:${cfg.tradingHttpsPort}/api/authn`,
  websocketUrl:
    process.env.TRADER_TRADING_WEBSOCKET_URL ??
    `wss://${cfg.host}:${cfg.tradingWsPort}${TRADING_WEBSOCKET_PATH}`,
});
