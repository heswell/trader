// Preload for UI tests (bun run test:ui): a browser-like global environment.
// Kept out of the server test run so DOM globals never leak into it.
import { readFileSync } from "node:fs";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { plugin } from "bun";

GlobalRegistrator.register({ url: "http://localhost/" });

// Components import their stylesheet as a string (`import css from "./X.css"`,
// inlined by the bundler) and inject it with useComponentCssInjection.
plugin({
  name: "css-as-text",
  setup(build) {
    build.onLoad({ filter: /\.css$/ }, ({ path }) => ({
      contents: `export default ${JSON.stringify(readFileSync(path, "utf8"))};`,
      loader: "js",
    }));
  },
});
