/**
 * bun scripts/stack/serve.ts host|features|portal|trading
 *
 *   portal    the stock vuu-portal server (@heswell/vuu-portal/main) with
 *             apps/portal-config/application.conf, ports / origins from the
 *             stack config (serverEnv: the conf's ${?VUU_*} overrides).
 *   trading   the trading Vuu server (apps/portal-config/src/start-trading.ts)
 *             with application.trading.conf, likewise.
 *   host      apps/portal-host/dist on TRADER_HOST_PORT (5100): SPA fallback
 *             to index.html for routes, and /config.json generated from the
 *             stack config (Keycloak URL, portal REST / websocket URLs).
 *   features  apps/features/trading/dist on TRADER_FEATURES_PORT (5110), one
 *             remote per /<key>/ (scripts/features/build.ts), with CORS.
 *             /<key>/config.json (the trading Vuu server the remote connects
 *             to) is generated from the current stack config, so TRADER_TRADING_*
 *             changes need no rebuild; the built copy is for other hosting.
 */
import { existsSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import {
  featureConfigJson,
  type StackConfig,
  serverEnv,
  stackConfig,
} from "./config";

const root = resolve(import.meta.dir, "../..");

export const hostConfigJson = (cfg: StackConfig) => ({
  authUrl: cfg.keycloakUrl,
  restUrl: `https://${cfg.host}:${cfg.portalHttpsPort}/api/authn`,
  websocketUrl: `wss://${cfg.host}:${cfg.portalWsPort}/websocket-portal`,
});

const fileIn = (dir: string, pathname: string) => {
  const path = resolve(dir, `.${decodeURIComponent(pathname)}`);
  if (path !== dir && !path.startsWith(dir + sep)) return undefined;
  return existsSync(path) && statSync(path).isFile() ? path : undefined;
};

const noStore = { "Cache-Control": "no-store" };

export const serveHost = (cfg = stackConfig()) => {
  const dist = resolve(root, "apps/portal-host/dist");
  if (!existsSync(resolve(dist, "index.html")))
    throw new Error(`${dist} not built: bun run build`);
  return Bun.serve({
    port: cfg.hostPort,
    fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === "/config.json")
        return Response.json(hostConfigJson(cfg), { headers: noStore });
      if (pathname === "/health") return new Response("ok");
      const file = fileIn(dist, pathname === "/" ? "/index.html" : pathname);
      if (file) {
        const html = file.endsWith(".html");
        return new Response(Bun.file(file), { headers: html ? noStore : {} });
      }
      // Client-side routes (/trading/..., /market/..., ...) get the app; missing assets 404.
      if (extname(pathname)) return new Response("Not found", { status: 404 });
      return new Response(Bun.file(resolve(dist, "index.html")), {
        headers: noStore,
      });
    },
  });
};

export const serveFeatures = (cfg = stackConfig()) => {
  const dist = resolve(root, "apps/features/trading/dist");
  if (!existsSync(dist)) throw new Error(`${dist} not built: bun run build`);
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "*",
  };
  return Bun.serve({
    port: cfg.featuresPort,
    fetch(req) {
      if (req.method === "OPTIONS")
        return new Response(null, { status: 204, headers: cors });
      const { pathname } = new URL(req.url);
      if (pathname === "/health") return new Response("ok", { headers: cors });
      const remoteConfig = /^\/([^/]+)\/config\.json$/.exec(pathname);
      if (remoteConfig && fileIn(dist, `/${remoteConfig[1]}/mf-manifest.json`))
        return Response.json(featureConfigJson(cfg), {
          headers: { ...cors, ...noStore },
        });
      const file = fileIn(
        dist,
        pathname.endsWith("/") ? `${pathname}index.html` : pathname,
      );
      if (file) {
        // The manifest must not be cached: it names the (hashed) chunks.
        const fresh = file.endsWith(".json") || file.endsWith(".html");
        return new Response(Bun.file(file), {
          headers: fresh ? { ...cors, ...noStore } : cors,
        });
      }
      return new Response("Not found", { status: 404, headers: cors });
    },
  });
};

if (import.meta.main) {
  const [which] = process.argv.slice(2);
  const cfg = stackConfig();
  if (which === "host") {
    serveHost(cfg);
    console.log(`portal host on ${cfg.hostOrigin}`);
  } else if (which === "features") {
    serveFeatures(cfg);
    console.log(`trading features on ${cfg.featuresOrigin}/<feature>/`);
  } else if (which === "portal") {
    Object.assign(process.env, serverEnv(cfg).portal);
    const { main } = await import("@heswell/vuu-portal/main");
    await main({
      configFile: resolve(root, "apps/portal-config/application.conf"),
    });
  } else if (which === "trading") {
    Object.assign(process.env, serverEnv(cfg).trading, {
      VUU_CONFIG_FILE: resolve(
        root,
        "apps/portal-config/application.trading.conf",
      ),
    });
    await import("../../apps/portal-config/src/start-trading");
  } else {
    console.error("usage: serve.ts host|features|portal|trading");
    process.exit(1);
  }
}
