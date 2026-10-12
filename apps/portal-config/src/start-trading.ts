/**
 * The trading Vuu server: EXCHANGE (exchange-sim) + OMS, configured by
 * ../application.trading.conf (or VUU_CONFIG_FILE). The portal server (the
 * stock vuu-portal, ../application.conf) only does module discovery and portal
 * auth; trading modules reach this server through their config.json.
 */
import { resolve } from "node:path";

process.env.VUU_CONFIG_FILE ??= resolve(
  import.meta.dir,
  "../application.trading.conf",
);
const { default: start } = await import("@heswell/oms/main");
await start();
