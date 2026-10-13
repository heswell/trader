import { mkdirSync } from "node:fs";

mkdirSync("logs", { recursive: true });
// keep test output quiet; run with VUU_LOG_LEVEL=info (or debug) to see server logs
process.env.VUU_LOG_LEVEL ??= "silent";
