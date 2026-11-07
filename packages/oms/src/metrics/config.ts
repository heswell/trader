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
}

export const DEFAULT_METRICS_CONFIG: Readonly<MetricsConfig> = Object.freeze({
  enabled: 1,
  intervalMs: 1_000,
});

const envName = (key: string) =>
  `METRICS_${key.replace(/([A-Z])/g, "_$1").toUpperCase()}`;

export const loadMetricsConfig = (
  source?: ConfigSource,
  env: Record<string, string | undefined> = process.env,
  overrides: Partial<MetricsConfig> = {},
): MetricsConfig => {
  const config = { ...DEFAULT_METRICS_CONFIG } as Record<string, number>;
  for (const key of Object.keys(DEFAULT_METRICS_CONFIG)) {
    const confKey = `metrics.${key}`;
    const envValue = env[envName(key)] || env[`TRADER_${envName(key)}`];
    if (envValue !== undefined && envValue !== "") {
      const value =
        envValue === "true" ? 1 : envValue === "false" ? 0 : Number(envValue);
      if (Number.isNaN(value)) {
        throw Error(`${envName(key)}='${envValue}' is not a number`);
      }
      config[key] = value;
    } else if (source?.has(confKey)) {
      config[key] = source.getNumber(confKey);
    }
  }
  const result = { ...(config as unknown as MetricsConfig), ...overrides };
  if (!(result.intervalMs > 0)) throw Error("metrics.intervalMs must be > 0");
  return result;
};
