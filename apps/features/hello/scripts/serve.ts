// Serves the built remote (dist/) with CORS on :5010. Run `bun run build` first.
import { resolve } from "node:path";

const dist = resolve(import.meta.dir, "../dist");
const port = Number(process.env.HELLO_PORT ?? 5010);

Bun.serve({
  port,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    const file = Bun.file(
      resolve(dist, `.${path === "/" ? "/index.html" : path}`),
    );
    const headers = { "Access-Control-Allow-Origin": "*" };
    if (!(await file.exists()))
      return new Response("Not found", { status: 404, headers });
    return new Response(file, { headers });
  },
});
console.log(`hello remote served from ${dist} on http://localhost:${port}`);
