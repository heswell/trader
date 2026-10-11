import { mkdirSync } from "node:fs";

// vuu-server writes its log files relative to cwd
mkdirSync("logs", { recursive: true });
