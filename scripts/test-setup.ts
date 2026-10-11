import { mkdirSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

mkdirSync("logs", { recursive: true });
// vuu-server writes its log files to <vuu-websocket>/logs
try {
  const server = realpathSync(
    resolve(import.meta.dir, "../node_modules/@heswell/vuu-server"),
  );
  mkdirSync(resolve(server, "../../logs"), { recursive: true });
} catch {}
