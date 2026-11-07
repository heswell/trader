import { TIMER_MODES, type TimerMode } from "@heswell/trading-metrics";
import type { ConfigSource } from "../config";

/**
 * Metrics configuration: `metrics.<key>` in application.conf or a
 * `METRICS_<KEY>` / `TRADER_METRICS_<KEY>` environment variable
 * (UPPER_SNAKE_CASE, env wins), e.g. `TRADER_METRICS_ENABLED=0`.
 * See docs/metrics.md.
 */
export interface MetricsConfig {
  /** 1 = publish the METRICS tables; 0 = no module and no collector timer. */
  enabled: number;
  /** Snapshot interval (ms). */
  intervalMs: number;
  /** Hot-path timers: off (count calls only), sampled, or all. */
  timers: TimerMode;
  /** `sampled`: time one call in this many (a power of two). */
  sampleEvery: number;
  /** metricsHistory snapshots kept per metric (0 = no history). */
  historySize: number;
}

export const DEFAULT_METRICS_CONFIG: Readonly<MetricsConfig> = Object.freeze({
  enabled: 1,
  intervalMs: 1_000,
  timers: "sampled",
  sampleEvery: 16,
  historySize: 300,
});

const envName = (key: string) =>
  `METRICS_${key.replace(/([A-Z])/g, "_$1").toUpperCase()}`;

const STRING_KEYS = new Set<string>(["timers"]);

const isPowerOfTwo = (n: number) =>
  Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;

export const loadMetricsConfig = (
  source?: ConfigSource,
  env: Record<string, string | undefined> = process.env,
  overrides: Partial<MetricsConfig> = {},
): MetricsConfig => {
  const config = { ...DEFAULT_METRICS_CONFIG } as Record<
    string,
    number | string
  >;
  for (const key of Object.keys(DEFAULT_METRICS_CONFIG)) {
    const confKey = `metrics.${key}`;
    const isString = STRING_KEYS.has(key);
    const envValue = env[envName(key)] || env[`TRADER_${envName(key)}`];
    if (envValue !== undefined && envValue !== "") {
      if (isString) {
        config[key] = envValue;
        continue;
      }
      const value =
        envValue === "true" ? 1 : envValue === "false" ? 0 : Number(envValue);
      if (Number.isNaN(value)) {
        throw Error(`${envName(key)}='${envValue}' is not a number`);
      }
      config[key] = value;
    } else if (source?.has(confKey)) {
      config[key] = isString
        ? source.getString(confKey)
        : source.getNumber(confKey);
    }
  }
  const result = { ...(config as unknown as MetricsConfig), ...overrides };
  if (!(result.intervalMs > 0)) throw Error("metrics.intervalMs must be > 0");
  if (!TIMER_MODES.includes(result.timers)) {
    throw Error(
      `metrics.timers must be one of ${TIMER_MODES.join(", ")}, got '${result.timers}'`,
    );
  }
  if (!(Number.isInteger(result.historySize) && result.historySize >= 0)) {
    throw Error(
      `metrics.historySize must be a whole number >= 0, got ${result.historySize}`,
    );
  }
  if (!isPowerOfTwo(result.sampleEvery)) {
    throw Error(
      `metrics.sampleEvery must be a power of two, got ${result.sampleEvery}`,
    );
  }
  return result;
};
