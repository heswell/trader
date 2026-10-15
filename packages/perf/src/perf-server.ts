/**
 * Trading server for the perf harness: @heswell/oms/main with
 * ../application.perf.conf (permissive auth, ports from VUU_WEBSOCKET_PORT /
 * VUU_HTTPS_PORT). Set TRADER_PERF_STATS_FILE for the stats JSONL.
 */
import { resolve } from "node:path";

process.env.VUU_CONFIG_FILE ??= resolve(
  import.meta.dir,
  "../application.perf.conf",
);
const { default: start } = await import("@heswell/oms/main");
await start();
console.log("perf-server ready");
