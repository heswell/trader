/**
 * Keycloak realm "vuu" for the trader stack:
 *
 *   vuu-portal             public, the portal host's login. Owns the
 *                          navigation roles (modules' accessRole) and puts
 *                          both server clients in its tokens' audience.
 *   vuu-portal-server      confidential, the audience the portal server requires.
 *   trader-trading-server  confidential, the trading Vuu server (exchange-sim +
 *                          OMS). It exchanges the portal user's token for its own
 *                          (standard token exchange) and owns the trading roles.
 *
 *   bun scripts/stack/keycloak-realm.ts export     # writes infra/keycloak/realm-vuu.json
 *   bun scripts/stack/keycloak-realm.ts bootstrap  # creates the realm in a running Keycloak
 *   bun scripts/stack/keycloak-realm.ts bootstrap --reset   # drop + recreate
 *
 * DEV ONLY: every user's password is DEV_PASSWORD.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  TRADING_ACCESS_ROLE,
  type TradingRole,
} from "../../apps/features/trading/src/catalog";
import { type StackConfig, stackConfig, TRADING_CLIENT_ID } from "./config";

export const DEV_PASSWORD = process.env.TRADER_DEV_PASSWORD ?? "password";
/** Must match vuu.auth.keycloak.clientSecret in apps/portal-config/application.conf. */
export const SERVER_CLIENT_SECRET = "vuu-portal-local-dev-secret";
/** Must match vuu.auth.keycloak.clientSecret in apps/portal-config/application.trading.conf. */
export const TRADING_CLIENT_SECRET = "trader-trading-local-dev-secret";

export const TRADING_ROLES = Object.keys(TRADING_ACCESS_ROLE) as TradingRole[];

export const PORTAL_CLIENT_ROLES = [
  ...Object.values(TRADING_ACCESS_ROLE),
  "module-admin-access",
  "vuu-table-viewer-access",
] as const;

type PortalRole = (typeof PORTAL_CLIENT_ROLES)[number];

/**
 * Each user's trading roles also grant the matching navigation role; `portal`
 * lists any other vuu-portal roles.
 */
export const SEEDED_USERS: {
  username: string;
  name: string;
  roles: TradingRole[];
  portal?: PortalRole[];
}[] = [
  {
    username: "alice",
    name: "Alice Trader",
    roles: ["trading-view", "trading-execute"],
  },
  {
    username: "bob",
    name: "Bob Trader",
    roles: ["trading-view", "trading-execute"],
  },
  {
    username: "carol",
    name: "Carol Trader",
    roles: ["trading-view", "trading-execute"],
  },
  { username: "dave", name: "Dave Viewer", roles: ["trading-view"] },
  {
    username: "erin",
    name: "Erin Trader",
    roles: ["trading-view", "trading-execute"],
  },
  {
    username: "sam",
    name: "Sam Supervisor",
    roles: ["trading-view", "trading-supervisor"],
  },
  {
    username: "admin",
    name: "Portal Admin",
    roles: ["trading-view", "trading-supervisor"],
    portal: ["module-admin-access", "vuu-table-viewer-access"],
  },
];

export const portalRolesOf = (user: (typeof SEEDED_USERS)[number]) => [
  ...user.roles.map((role) => TRADING_ACCESS_ROLE[role]),
  ...(user.portal ?? []),
];

const audienceMapper = (audience: string) => ({
  name: `audience-${audience}`,
  protocol: "openid-connect",
  protocolMapper: "oidc-audience-mapper",
  consentRequired: false,
  config: {
    "included.client.audience": audience,
    "id.token.claim": "false",
    "access.token.claim": "true",
    "introspection.token.claim": "true",
  },
});

const serverClient = (clientId: string, name: string, secret: string) => ({
  clientId,
  name,
  enabled: true,
  publicClient: false,
  secret,
  standardFlowEnabled: false,
  directAccessGrantsEnabled: false,
  serviceAccountsEnabled: true,
  fullScopeAllowed: false,
  attributes: { "standard.token.exchange.enabled": "true" },
  protocolMappers: [audienceMapper(clientId)],
});

export const buildRealm = (cfg: Pick<StackConfig, "hostOrigin">) => {
  const origins = [...new Set([cfg.hostOrigin, "http://localhost:5100"])];
  const clientRoles = (names: readonly string[]) =>
    names.map((name) => ({ name, clientRole: true }));
  return {
    realm: "vuu",
    enabled: true,
    displayName: "Trader (dev)",
    sslRequired: "external",
    accessTokenLifespan: 1800,
    ssoSessionIdleTimeout: 36000,
    clients: [
      {
        clientId: "vuu-portal",
        name: "Vuu portal host",
        enabled: true,
        publicClient: true,
        standardFlowEnabled: true,
        directAccessGrantsEnabled: false,
        fullScopeAllowed: false,
        redirectUris: origins.map((o) => `${o}/*`),
        webOrigins: origins,
        attributes: {
          "pkce.code.challenge.method": "S256",
          "post.logout.redirect.uris": "+",
        },
        // Token exchange requires the requesting client in the subject
        // token's audience.
        protocolMappers: [
          audienceMapper("vuu-portal-server"),
          audienceMapper(TRADING_CLIENT_ID),
        ],
      },
      serverClient(
        "vuu-portal-server",
        "Vuu portal server",
        SERVER_CLIENT_SECRET,
      ),
      serverClient(
        TRADING_CLIENT_ID,
        "Trader trading server (exchange-sim + OMS)",
        TRADING_CLIENT_SECRET,
      ),
    ],
    roles: {
      client: {
        "vuu-portal": clientRoles(PORTAL_CLIENT_ROLES),
        [TRADING_CLIENT_ID]: clientRoles(TRADING_ROLES),
      },
    },
    users: SEEDED_USERS.map((user) => {
      const [firstName, lastName] = user.name.split(" ");
      return {
        username: user.username,
        enabled: true,
        email: `${user.username}@trader.example`,
        emailVerified: true,
        firstName,
        lastName,
        credentials: [
          { type: "password", value: DEV_PASSWORD, temporary: false },
        ],
        clientRoles: {
          "vuu-portal": portalRolesOf(user),
          [TRADING_CLIENT_ID]: user.roles,
        },
      };
    }),
  };
};

const adminToken = async (url: string) => {
  const res = await fetch(
    `${url}/realms/master/protocol/openid-connect/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "password",
        client_id: "admin-cli",
        username: process.env.KEYCLOAK_ADMIN_USERNAME ?? "admin",
        password: process.env.KEYCLOAK_ADMIN_PASSWORD ?? "admin",
      }),
      tls: { rejectUnauthorized: false },
    } as RequestInit,
  );
  if (!res.ok)
    throw new Error(
      `keycloak admin login failed: ${res.status} ${await res.text()}`,
    );
  return ((await res.json()) as { access_token: string }).access_token;
};

/**
 * Create realm "vuu" unless it exists (reset: delete it first). A realm from
 * before the trading server had its own client is recreated.
 */
export const bootstrapRealm = async (cfg: StackConfig, reset = false) => {
  const token = await adminToken(cfg.keycloakUrl);
  const call = (path: string, init: RequestInit = {}) =>
    fetch(`${cfg.keycloakUrl}/admin/realms${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      tls: { rejectUnauthorized: false },
    } as RequestInit);
  let recreated = false;
  const existing = await call(`/${cfg.keycloakRealm}`);
  if (existing.ok) {
    const tradingClient = await call(
      `/${cfg.keycloakRealm}/clients?clientId=${TRADING_CLIENT_ID}`,
    );
    const outdated =
      tradingClient.ok && ((await tradingClient.json()) as []).length === 0;
    if (!reset && !outdated) return "exists";
    await call(`/${cfg.keycloakRealm}`, { method: "DELETE" });
    recreated = true;
  }
  const res = await call("", {
    method: "POST",
    body: JSON.stringify(buildRealm(cfg)),
  });
  if (!res.ok)
    throw new Error(`realm import failed: ${res.status} ${await res.text()}`);
  return recreated ? "recreated" : "created";
};

if (import.meta.main) {
  const [command] = process.argv.slice(2);
  const cfg = stackConfig();
  if (command === "export") {
    const file = resolve(
      import.meta.dir,
      "../../infra/keycloak/realm-vuu.json",
    );
    writeFileSync(file, `${JSON.stringify(buildRealm(cfg), null, 2)}\n`);
    console.log(`wrote ${file}`);
  } else if (command === "bootstrap") {
    const result = await bootstrapRealm(cfg, process.argv.includes("--reset"));
    console.log(`realm ${cfg.keycloakRealm} ${result} at ${cfg.keycloakUrl}`);
  } else {
    console.error("usage: keycloak-realm.ts export | bootstrap [--reset]");
    process.exit(1);
  }
}
