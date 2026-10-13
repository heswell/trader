import { createRequire } from "node:module";
import { resolve } from "node:path";
import { defineConfig, rspack } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";

const require = createRequire(import.meta.url);

/** Remote (standalone) trading server: `bun run dev:trading-server`. */
const REMOTE_WS = process.env.TRADING_REMOTE_WS ?? "ws://localhost:8095";
const REMOTE_WS_PATH =
  process.env.TRADING_REMOTE_WS_PATH ?? "/websocket-trading";
const REMOTE_AUTH = process.env.TRADING_REMOTE_AUTH ?? "http://localhost:8447";

export default defineConfig({
  plugins: [pluginReact()],
  html: {
    title: "Trading UI showcase",
  },
  source: {
    entry: { index: "./src/index.tsx" },
  },
  server: {
    port: 5001,
    // Same-origin access to the remote server (no CORS). The standalone server
    // is plain http/ws; `secure: false` still allows an https target with the
    // self-signed dev cert via TRADING_REMOTE_*.
    proxy: {
      "/remote/trading/authn": {
        target: REMOTE_AUTH,
        secure: false,
        changeOrigin: true,
        pathRewrite: { "^/remote/trading/authn": "/api/authn" },
      },
      "/remote/trading/ws": {
        target: REMOTE_WS,
        secure: false,
        changeOrigin: true,
        ws: true,
        pathRewrite: { "^/remote/trading/ws": REMOTE_WS_PATH },
      },
    },
  },
  tools: {
    rspack: {
      plugins: [
        // hft-limit-order-book (exchange-sim) imports randomUUID from
        // node:crypto; a resolve alias does not apply to node: URIs.
        new rspack.NormalModuleReplacementPlugin(
          /^node:crypto$/,
          require.resolve("@heswell/trading-test-data/shims/node-crypto"),
        ),
      ],
      module: {
        rules: [
          {
            test: /\.tsx?$/,
            enforce: "pre",
            include: [
              resolve(import.meta.dirname, "src"),
              resolve(import.meta.dirname, "../../packages/trading-ui/src"),
            ],
            use: [resolve(import.meta.dirname, "css-inline-loader.cjs")],
          },
        ],
      },
    },
  },
});
