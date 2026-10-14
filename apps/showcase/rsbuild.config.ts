import { resolve } from "node:path";
import { defineConfig } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";

/**
 * Remote (standalone) trading server: `bun run dev:trading-server`. The
 * showcase calls it directly; its conf lists this origin in
 * vuu.auth.cors.allowedOrigins.
 */
const REMOTE_WS =
  process.env.TRADING_REMOTE_WS ?? "ws://localhost:8095/websocket-trading";
const REMOTE_AUTH =
  process.env.TRADING_REMOTE_AUTH ?? "http://localhost:8447/api/authn";

export default defineConfig({
  plugins: [pluginReact()],
  html: {
    title: "Trading UI showcase",
  },
  source: {
    entry: { index: "./src/index.tsx" },
    define: {
      "process.env.TRADING_REMOTE_WS": JSON.stringify(REMOTE_WS),
      "process.env.TRADING_REMOTE_AUTH": JSON.stringify(REMOTE_AUTH),
    },
  },
  server: {
    port: 5001,
  },
  tools: {
    rspack: {
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
