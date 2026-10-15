import type { StoreKind } from "@heswell/trading-persistence";
import type { ConfigSource } from "../config";

/**
 * Persistence configuration: `persistence.<key>` in application.conf or a
 * `PERSISTENCE_<KEY>` / `TRADER_PERSISTENCE_<KEY>` environment variable
 * (UPPER_SNAKE_CASE, env wins), e.g. `TRADER_PERSISTENCE_STORE=file`,
 * `TRADER_PERSISTENCE_RESET=1`. `TRADER_DATA_DIR` is an alias for
 * `PERSISTENCE_DIR`. See docs/persistence.md.
 */
export interface PersistenceConfig {
  /** memory (nothing survives the process), file or sqlite. */
  store: string;
  /** Directory of the file store / sqlite database (relative to the cwd). */
  dir: string;
  /** 1 = fsync every journal write (survives power loss, slower). */
  fsync: number;
  /** Snapshot (and compact the journal) this often (ms); 0 = only on shutdown. */
  snapshotIntervalMs: number;
  /** Also snapshot once the journal holds this many entries; 0 = off. */
  snapshotEveryEntries: number;
  /** 1 = delete all persisted state at startup (fresh start). */
  reset: number;
  /** 1 = expire live exchange orders that no OMS order owns after a restore. */
  cancelOrphans: number;
}

export const DEFAULT_PERSISTENCE_CONFIG: Readonly<PersistenceConfig> =
  Object.freeze({
    store: "memory",
    dir: ".data/trading",
    fsync: 0,
    snapshotIntervalMs: 60_000,
    snapshotEveryEntries: 50_000,
    reset: 0,
    cancelOrphans: 1,
  });

const STORES: readonly StoreKind[] = ["memory", "file", "sqlite"];

const envName = (key: string) =>
  `PERSISTENCE_${key.replace(/([A-Z])/g, "_$1").toUpperCase()}`;

export const validatePersistenceConfig = (config: PersistenceConfig) => {
  if (!STORES.includes(config.store as StoreKind)) {
    throw Error(
      `persistence.store '${config.store}' must be one of ${STORES.join(", ")}`,
    );
  }
  if (config.store !== "memory" && config.dir.trim() === "") {
    throw Error("persistence.dir is required for a file / sqlite store");
  }
  for (const key of ["snapshotIntervalMs", "snapshotEveryEntries"] as const) {
    if (!(config[key] >= 0)) throw Error(`persistence.${key} must be >= 0`);
  }
  return config;
};

export const loadPersistenceConfig = (
  source?: ConfigSource,
  env: Record<string, string | undefined> = process.env,
  overrides: Partial<PersistenceConfig> = {},
): PersistenceConfig => {
  const config = { ...DEFAULT_PERSISTENCE_CONFIG } as Record<
    string,
    string | number
  >;
  for (const [key, defaultValue] of Object.entries(
    DEFAULT_PERSISTENCE_CONFIG,
  )) {
    const confKey = `persistence.${key}`;
    const envValue =
      env[envName(key)] ||
      env[`TRADER_${envName(key)}`] ||
      (key === "dir" ? env.TRADER_DATA_DIR : undefined);
    const isString = typeof defaultValue === "string";
    if (envValue !== undefined && envValue !== "") {
      const value = isString
        ? envValue
        : envValue === "true"
          ? 1
          : envValue === "false"
            ? 0
            : Number(envValue);
      if (!isString && Number.isNaN(value)) {
        throw Error(`${envName(key)}='${envValue}' is not a number`);
      }
      config[key] = value;
    } else if (source?.has(confKey)) {
      config[key] = isString
        ? source.getString(confKey)
        : source.getNumber(confKey);
    }
  }
  return validatePersistenceConfig({
    ...(config as unknown as PersistenceConfig),
    ...overrides,
  });
};
