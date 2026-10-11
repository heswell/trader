import { resolve } from "node:path";

export const configFile = resolve(import.meta.dir, "../application.conf");

/** Point vuu-server's ConfigFactory at this app's application.conf unless overridden. */
export const useConfigFile = () => {
  process.env.VUU_CONFIG_FILE ??= configFile;
};
