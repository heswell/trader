/**
 * Headless Keycloak login for the start:all stack: the vuu-portal client is
 * public with direct access grants disabled, so do what the browser does
 * (authorization code + PKCE), scraping the login form.
 */
import { createHash, randomBytes } from "node:crypto";

const b64url = (buf: Buffer) => buf.toString("base64url");

const cookieHeader = (response: Response, jar: Map<string, string>) => {
  for (const cookie of response.headers.getSetCookie()) {
    const [pair] = cookie.split(";");
    const eq = pair.indexOf("=");
    jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1));
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
};

export interface KeycloakLoginOptions {
  keycloakUrl: string;
  realm: string;
  clientId: string;
  /** A redirect URI registered for the client (e.g. the portal host origin). */
  redirectUri: string;
  username: string;
  password: string;
}

/** Keycloak access token for the user. */
export async function keycloakLogin(options: KeycloakLoginOptions) {
  const { keycloakUrl, realm, clientId, redirectUri, username, password } =
    options;
  const tls = { rejectUnauthorized: false };
  const base = `${keycloakUrl}/realms/${realm}/protocol/openid-connect`;
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const jar = new Map<string, string>();
  const authUrl = `${base}/auth?${new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    scope: "openid",
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: b64url(randomBytes(8)),
  })}`;
  const page = await fetch(authUrl, { tls });
  if (!page.ok) throw Error(`Keycloak auth page: HTTP ${page.status}`);
  const html = await page.text();
  const action = /<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"/.exec(
    html,
  )?.[1];
  if (!action) throw Error("Keycloak login form not found");
  const submit = await fetch(action.replaceAll("&amp;", "&"), {
    method: "POST",
    redirect: "manual",
    tls,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookieHeader(page, jar),
    },
    body: new URLSearchParams({ username, password, credentialId: "" }),
  });
  const location = submit.headers.get("location") ?? "";
  const code = new URL(location, redirectUri).searchParams.get("code");
  if (!code) {
    throw Error(
      `Keycloak login for ${username} failed (HTTP ${submit.status})`,
    );
  }
  const token = await fetch(`${base}/token`, {
    method: "POST",
    tls,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });
  if (!token.ok) throw Error(`Keycloak token: HTTP ${token.status}`);
  return ((await token.json()) as { access_token: string }).access_token;
}
