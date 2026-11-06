import { parseBarInterval, VOLUME_PROFILES } from "@heswell/trading-schemas";
import { validateSessionConfig } from "./engine/TradingSession";

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
  /**
   * Market impact: the share of each instrument's variance that comes from
   * aggressive flow (0 = no impact). The impact constant is worked out once
   * at startup from the default taker flow and the walk's own volatility
   * is scaled down to match, so total volatility is about unchanged.
   */
  impactVolShare: number;
  /** Share of each impact move that is permanent (the rest fades). */
  impactPermanentShare: number;
  /** Half-life of transient impact, wall-clock seconds. */
  impactHalfLifeSec: number;
  /**
   * Session open, "HH:MM" UTC. Set together with sessionClose; both empty
   * (and sessionDayMs 0) = no schedule, the market is always CONTINUOUS.
   */
  sessionOpen: string;
  /** Session close, "HH:MM" UTC (earlier than sessionOpen = overnight session). */
  sessionClose: string;
  /** Minutes of PRE_OPEN (order entry, no bots) before sessionOpen. */
  preOpenMinutes: number;
  /**
   * 0 = real 24h day. > 0 = fast simulated day: the 24h schedule is
   * compressed into this many ms of clock time; open/close default to
   * 08:00/16:30 when unset.
   */
  sessionDayMs: number;
  /**
   * Intraday volume curve the taker bots follow while a session schedule is
   * configured: "u" (busy open and close, quiet middle) or "flat". No effect
   * without a schedule.
   */
  volumeProfile: string;
  /**
   * Random variation of taker activity around the curve (0 = none), so
   * actual volume differs from the forecast: a per-day level plus a slowly
   * wandering component, each roughly +/- this fraction.
   */
  volumeNoise: number;
  /**
   * Comma separated OHLCV bar intervals for the `bars` table, e.g.
   * "1s,1m,5m" (units s, m, h). Intervals are exchange-clock time; empty
   * disables bars.
   */
  barIntervals: string;
  /** Closed bars kept per ric and interval (oldest deleted). */
  barHistory: number;
  /** 1 = seed `barHistory` synthetic closed bars per series at startup; 0 = off. */
  barBackfill: number;
  /** Interval of `bookSamples` snapshots per instrument (ms); 0 disables. */
  bookSampleIntervalMs: number;
  /** Samples kept per instrument (oldest deleted). */
  bookSampleHistory: number;
  /** 1 = publish the L3 `bookOrders` table (one row per resting order); 0 = off. */
  bookOrders: number;
  /**
   * 1 = publish every L3 event to the `bookEvents` tape; 0 = off. Roughly
   * doubles table updates at the default load.
   */
  bookEvents: number;
  /** `bookEvents` rows kept, across all instruments (oldest deleted). */
  bookEventsCapacity: number;
  /** Interval of the sim-admin `simBooks` / `bots` updates (ms); 0 disables them. */
  simPublishIntervalMs: number;
  /** Interval of `simSamples` per instrument (ms); 0 disables. */
  simSampleIntervalMs: number;
  /** Sim samples kept per instrument (oldest deleted). */
  simSampleHistory: number;
  /** Interval of `botHistory` samples per bot (ms); 0 disables. */
  botHistoryIntervalMs: number;
  /** Bot history samples kept per bot (oldest deleted). */
  botHistorySamples: number;
  /** `botFills` rows kept (two per trade, oldest deleted); 0 disables. */
  botFillsCapacity: number;
  /** Markout horizon of `botFills` (ms of clock time). */
  markoutMs: number;
  /**
   * Who may see the sim-admin tables and call the exchange admin RPCs.
   * "auto": users with the sim-admin role, and users with no roles at all
   * (dev / permissive auth grants none). "strict": sim-admin only.
   */
  permissionMode: string;
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
  impactVolShare: 0.25,
  impactPermanentShare: 0.3,
  impactHalfLifeSec: 30,
  sessionOpen: "",
  sessionClose: "",
  preOpenMinutes: 0,
  sessionDayMs: 0,
  volumeProfile: "u",
  volumeNoise: 0.3,
  barIntervals: "1s,1m,5m",
  barHistory: 500,
  barBackfill: 1,
  bookSampleIntervalMs: 1_000,
  bookSampleHistory: 300,
  bookOrders: 1,
  bookEvents: 0,
  bookEventsCapacity: 50_000,
  simPublishIntervalMs: 1_000,
  simSampleIntervalMs: 1_000,
  simSampleHistory: 300,
  botHistoryIntervalMs: 5_000,
  botHistorySamples: 120,
  botFillsCapacity: 20_000,
  markoutMs: 5_000,
  permissionMode: "auto",
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

/** Parsed `barIntervals` labels (empty list = bars disabled). */
export const barIntervalList = (barIntervals: string) =>
  barIntervals
    .split(",")
    .map((label) => label.trim())
    .filter(Boolean);

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
    "bookSampleIntervalMs",
    "simPublishIntervalMs",
    "simSampleIntervalMs",
    "botHistoryIntervalMs",
    "botFillsCapacity",
    "markoutMs",
  ] as const) {
    if (!(config[key] >= 0)) throw Error(`exchangeSim.${key} must be >= 0`);
  }
  if (!(config.impactVolShare >= 0 && config.impactVolShare < 1)) {
    throw Error("exchangeSim.impactVolShare must be in [0, 1)");
  }
  if (!(config.impactPermanentShare > 0 && config.impactPermanentShare <= 1)) {
    throw Error("exchangeSim.impactPermanentShare must be in (0, 1]");
  }
  if (!(config.impactHalfLifeSec >= 0)) {
    throw Error("exchangeSim.impactHalfLifeSec must be >= 0");
  }
  if (config.permissionMode !== "auto" && config.permissionMode !== "strict") {
    throw Error("exchangeSim.permissionMode must be 'auto' or 'strict'");
  }
  if (!(config.volumeProfile in VOLUME_PROFILES)) {
    throw Error(
      `exchangeSim.volumeProfile must be one of ${Object.keys(VOLUME_PROFILES).join(", ")}`,
    );
  }
  if (!(config.volumeNoise >= 0 && config.volumeNoise < 1)) {
    throw Error("exchangeSim.volumeNoise must be in [0, 1)");
  }
  for (const key of [
    "barHistory",
    "bookSampleHistory",
    "bookEventsCapacity",
    "simSampleHistory",
    "botHistorySamples",
  ] as const) {
    if (!(Number.isInteger(config[key]) && config[key] > 0)) {
      throw Error(`exchangeSim.${key} must be a positive integer`);
    }
  }
  for (const key of ["barBackfill", "bookOrders", "bookEvents"] as const) {
    if (config[key] !== 0 && config[key] !== 1) {
      throw Error(`exchangeSim.${key} must be 0 or 1`);
    }
  }
  const intervals = barIntervalList(config.barIntervals);
  if (new Set(intervals).size !== intervals.length) {
    throw Error(
      `exchangeSim.barIntervals has duplicates: ${config.barIntervals}`,
    );
  }
  for (const label of intervals) {
    try {
      parseBarInterval(label);
    } catch (err) {
      throw Error(`exchangeSim.barIntervals: ${(err as Error).message}`);
    }
  }
  validateSessionConfig(config);
  return config;
};
