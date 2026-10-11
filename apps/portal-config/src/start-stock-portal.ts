// Starts the unmodified vuu-portal against this directory's config.
import { useConfigFile } from "./portal-server";

useConfigFile();
const { default: start } = await import("@heswell/vuu-portal");
await start();
