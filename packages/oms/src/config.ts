/**
 * OMS configuration. Every knob can be set in application.conf as
 * `oms.<key>` or with an `OMS_<KEY>` environment variable (UPPER_SNAKE_CASE of
 * the key, env wins), e.g. `oms.flowRate=5` / `OMS_FLOW_RATE=5`.
 */
export interface OmsConfig {
  /** RNG seed of the background flow. */
  seed: number;
  /** Background ("other traders") orders per second, total. 0 disables the flow. */
  flowRate: number;
  /** Comma separated accounts the flow trades for; empty = every enabled seeded account. */
  flowAccounts: string;
  /** Target notional (USD) of a background order. */
  flowNotionalUsd: number;
  /** Max working background orders; above this the flow cancels before it adds. */
  flowMaxWorking: number;
  /** Probability that a flow tick amends or cancels a working order instead of adding one. */
  flowCancelRate: number;
  /** Interval of the background flow timer (ms). */
  flowStepMs: number;
  /** Limit price collar vs reference (last, else mid, else refPrice), e.g. 0.1 = ±10%. */
  collarPct: number;
  /** Interval at which positions are marked to market (ms). 0 disables the timer. */
  markIntervalMs: number;
  /**
   * Interval of pnlHistory / accountPnlHistory samples (ms), taken on the
   * mark timer. 0 disables P&L history.
   */
  pnlHistoryIntervalMs: number;
  /** Samples kept per position and per account (oldest deleted). */
  pnlHistoryLength: number;
  /** Comma separated restricted rics (orders rejected RESTRICTED_INSTRUMENT). */
  restrictedRics: string;
  /**
   * `auto`: users without any trading-* role get dev defaults (see README);
   * `strict`: such users see nothing and cannot trade.
   */
  permissionMode: string;
  /** Simulated one-way latency (ms) between OMS and exchange; 0 = synchronous. */
  gatewayLatencyMs: number;
}

export const DEFAULT_OMS_CONFIG: Readonly<OmsConfig> = Object.freeze({
  seed: 7,
  flowRate: 2,
  flowAccounts: "",
  flowNotionalUsd: 25_000,
  flowMaxWorking: 40,
  flowCancelRate: 0.25,
  flowStepMs: 100,
  collarPct: 0.1,
  markIntervalMs: 500,
  pnlHistoryIntervalMs: 10_000,
  pnlHistoryLength: 180,
  restrictedRics: "",
  permissionMode: "auto",
  gatewayLatencyMs: 0,
});

export interface ConfigSource {
  has(key: string): boolean;
  getString(key: string, defaultValue?: string): string;
  getNumber(key: string, defaultValue?: number): number;
}

const envName = (key: string) =>
  `OMS_${key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase()}`;

export const loadOmsConfig = (
  source?: ConfigSource,
  env: Record<string, string | undefined> = process.env,
  overrides: Partial<OmsConfig> = {},
): OmsConfig => {
  const config = { ...DEFAULT_OMS_CONFIG } as Record<string, string | number>;
  for (const [key, defaultValue] of Object.entries(DEFAULT_OMS_CONFIG)) {
    const confKey = `oms.${key}`;
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
  return validateOmsConfig({
    ...(config as unknown as OmsConfig),
    ...overrides,
  });
};

export const validateOmsConfig = (config: OmsConfig) => {
  for (const key of [
    "flowRate",
    "flowMaxWorking",
    "markIntervalMs",
    "gatewayLatencyMs",
    "pnlHistoryIntervalMs",
  ] as const) {
    if (!(config[key] >= 0)) throw Error(`oms.${key} must be >= 0`);
  }
  if (
    !(Number.isInteger(config.pnlHistoryLength) && config.pnlHistoryLength > 0)
  ) {
    throw Error("oms.pnlHistoryLength must be a positive integer");
  }
  for (const key of ["flowNotionalUsd", "flowStepMs"] as const) {
    if (!(config[key] > 0)) throw Error(`oms.${key} must be > 0`);
  }
  if (!(config.collarPct > 0 && config.collarPct < 1)) {
    throw Error("oms.collarPct must be in (0, 1)");
  }
  if (!(config.flowCancelRate >= 0 && config.flowCancelRate <= 1)) {
    throw Error("oms.flowCancelRate must be in [0, 1]");
  }
  if (config.permissionMode !== "auto" && config.permissionMode !== "strict") {
    throw Error("oms.permissionMode must be 'auto' or 'strict'");
  }
  return config;
};

export const splitList = (value: string) =>
  value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
