/**
 * Exchange simulator configuration. Every knob can be set in application.conf
 * as `exchangeSim.<key>` or with an `EXCHANGE_SIM_<KEY>` environment variable
 * (UPPER_SNAKE_CASE of the key, env wins), e.g.
 * `exchangeSim.activeInstruments=50` / `EXCHANGE_SIM_ACTIVE_INSTRUMENTS=50`.
 */
export interface ExchangeSimConfig {
  /** Number of instruments with a live book (taken in universe order, interleaved by venue). */
  activeInstruments: number;
  /** Comma separated rics to simulate; overrides activeInstruments when set. */
  instruments: string;
  /** RNG seed; the same seed + clock reproduces the same market. */
  seed: number;
  /** Interval of the bot/price-model step timer (ms). */
  botStepMs: number;
  /** Elapsed time per step is clamped to this (ms) so a stalled loop doesn't burst. */
  maxStepMs: number;
  /** Max book operations per step; remaining books are deferred to the next step. */
  maxOpsPerStep: number;
  /** Interval at which dirty books are published to the Vuu tables (ms). */
  publishIntervalMs: number;
  /** Levels per side published to the depth table. */
  depthLevels: number;
  /** Trades table ring buffer capacity (oldest rows evicted). */
  tradesCapacity: number;
  /** Static price band around refPrice, e.g. 0.2 = ±20%. */
  priceBandPct: number;
  /** Simulated-time multiplier for the price model (1 = real time). */
  timeScale: number;
  /** Annualised volatility for every instrument; 0 = per-instrument default (20–50%). */
  defaultVolatility: number;
  /** Market makers per instrument. */
  mmPerInstrument: number;
  /** Quote levels per side per market maker. */
  mmLevels: number;
  /** Market-maker discretionary cancel/replace churn, events/s per instrument. */
  mmRate: number;
  /** Taker/noise order arrivals, orders/s per instrument. */
  takerRate: number;
  /** Target notional (USD) of a typical order / quote level. */
  baseNotionalUsd: number;
}

export const DEFAULT_CONFIG: Readonly<ExchangeSimConfig> = Object.freeze({
  activeInstruments: 200,
  instruments: "",
  seed: 42,
  botStepMs: 20,
  maxStepMs: 250,
  maxOpsPerStep: 5_000,
  publishIntervalMs: 100,
  depthLevels: 10,
  tradesCapacity: 50_000,
  priceBandPct: 0.2,
  timeScale: 10,
  defaultVolatility: 0,
  mmPerInstrument: 2,
  mmLevels: 5,
  mmRate: 10,
  takerRate: 8,
  baseNotionalUsd: 20_000,
});

/** Structural subset of service-utils Config. */
export interface ConfigSource {
  has(key: string): boolean;
  getString(key: string, defaultValue?: string): string;
  getNumber(key: string, defaultValue?: number): number;
}

const envName = (key: string) =>
  `EXCHANGE_SIM_${key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase()}`;

export const loadExchangeSimConfig = (
  source?: ConfigSource,
  env: Record<string, string | undefined> = process.env,
  overrides: Partial<ExchangeSimConfig> = {},
): ExchangeSimConfig => {
  const config = { ...DEFAULT_CONFIG } as Record<string, string | number>;
  for (const [key, defaultValue] of Object.entries(DEFAULT_CONFIG)) {
    const confKey = `exchangeSim.${key}`;
    const envValue = env[envName(key)];
    const isString = typeof defaultValue === "string";
    if (envValue !== undefined && envValue !== "") {
      const value = isString ? envValue : Number(envValue);
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
  return validateConfig({
    ...(config as unknown as ExchangeSimConfig),
    ...overrides,
  });
};

export const validateConfig = (config: ExchangeSimConfig) => {
  const positive: (keyof ExchangeSimConfig)[] = [
    "botStepMs",
    "maxStepMs",
    "maxOpsPerStep",
    "publishIntervalMs",
    "depthLevels",
    "tradesCapacity",
    "timeScale",
    "mmLevels",
    "baseNotionalUsd",
  ];
  for (const key of positive) {
    if (!((config[key] as number) > 0)) {
      throw Error(`exchangeSim.${key} must be > 0`);
    }
  }
  if (!(config.priceBandPct > 0 && config.priceBandPct < 1)) {
    throw Error("exchangeSim.priceBandPct must be in (0, 1)");
  }
  for (const key of [
    "activeInstruments",
    "mmPerInstrument",
    "mmRate",
    "takerRate",
    "defaultVolatility",
  ] as const) {
    if (!(config[key] >= 0)) throw Error(`exchangeSim.${key} must be >= 0`);
  }
  return config;
};
