/**
 * Keycloak realm "vuu" for the trader stack: the clients vuu-portal (public,
 * used by the portal host) and vuu-portal-server (confidential, the audience
 * the portal server requires), the trading client roles and seeded dev users.
 *
 *   bun scripts/stack/keycloak-realm.ts export     # writes infra/keycloak/realm-vuu.json
 *   bun scripts/stack/keycloak-realm.ts bootstrap  # creates the realm in a running Keycloak
 *   bun scripts/stack/keycloak-realm.ts bootstrap --reset   # drop + recreate
 *
 * DEV ONLY: every user's password is DEV_PASSWORD.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { type StackConfig, stackConfig } from "./config";

export const DEV_PASSWORD = process.env.TRADER_DEV_PASSWORD ?? "password";
/** Must match vuu.auth.keycloak.clientSecret in apps/portal-config/application.conf. */
export const SERVER_CLIENT_SECRET = "vuu-portal-local-dev-secret";

export const PORTAL_CLIENT_ROLES = [
  "trading-view",
  "trading-execute",
  "trading-supervisor",
  "module-admin-access",
  "vuu-table-viewer-access",
] as const;

type Role = (typeof PORTAL_CLIENT_ROLES)[number];

export const SEEDED_USERS: { username: string; name: string; roles: Role[] }[] =
  [
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
      roles: [
        "trading-view",
        "trading-supervisor",
        "module-admin-access",
        "vuu-table-viewer-access",
      ],
    },
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

export const buildRealm = (cfg: Pick<StackConfig, "hostOrigin">) => {
  const origins = [...new Set([cfg.hostOrigin, "http://localhost:5100"])];
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
        protocolMappers: [audienceMapper("vuu-portal-server")],
      },
      {
        clientId: "vuu-portal-server",
        name: "Vuu portal server",
        enabled: true,
        publicClient: false,
        secret: SERVER_CLIENT_SECRET,
        standardFlowEnabled: false,
        serviceAccountsEnabled: true,
        fullScopeAllowed: false,
        attributes: { "standard.token.exchange.enabled": "true" },
        protocolMappers: [audienceMapper("vuu-portal-server")],
      },
    ],
    roles: {
      client: {
        "vuu-portal": PORTAL_CLIENT_ROLES.map((name) => ({
          name,
          clientRole: true,
        })),
      },
    },
    users: SEEDED_USERS.map(({ username, name, roles }) => {
      const [firstName, lastName] = name.split(" ");
      return {
        username,
        enabled: true,
        email: `${username}@trader.example`,
        emailVerified: true,
        firstName,
        lastName,
        credentials: [
          { type: "password", value: DEV_PASSWORD, temporary: false },
        ],
        clientRoles: { "vuu-portal": roles },
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

/** Create realm "vuu" unless it exists (reset: delete it first). */
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
  const existing = await call(`/${cfg.keycloakRealm}`);
  if (existing.ok) {
    if (!reset) return "exists";
    await call(`/${cfg.keycloakRealm}`, { method: "DELETE" });
  }
  const res = await call("", {
    method: "POST",
    body: JSON.stringify(buildRealm(cfg)),
  });
  if (!res.ok)
    throw new Error(`realm import failed: ${res.status} ${await res.text()}`);
  return "created";
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
