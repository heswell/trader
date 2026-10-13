import { resolve } from "node:path";

process.env.VUU_CONFIG_FILE ??= resolve(import.meta.dir, "../application.conf");
const { default: start } = await import("../src/Main");
await start();
