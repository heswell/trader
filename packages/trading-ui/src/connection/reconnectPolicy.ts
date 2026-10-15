/**
 * Reconnect backoff: exponential, capped, with jitter so that many tabs
 * (or many users) dropped by the same server restart do not all reconnect
 * in the same instant (docs/resilience.md).
 */
export interface ReconnectPolicy {
  /** Delay before the first attempt (ms). Default 1000. */
  initialDelayMs?: number;
  /** Upper bound for any delay (ms). Default 30000. */
  maxDelayMs?: number;
  /** Growth factor per attempt. Default 2. */
  multiplier?: number;
  /**
   * Fraction of each delay that is randomised, 0..1. A delay `d` becomes a
   * value in `[d * (1 - jitter), d]`. Default 0.5.
   */
  jitter?: number;
  /** Give up after this many failed attempts. Default Infinity (never). */
  maxAttempts?: number;
}

export const DEFAULT_RECONNECT_POLICY: Required<ReconnectPolicy> = {
  initialDelayMs: 1_000,
  maxDelayMs: 30_000,
  multiplier: 2,
  jitter: 0.5,
  maxAttempts: Number.POSITIVE_INFINITY,
};

/**
 * A policy with every field set: `policy` over DEFAULT_RECONNECT_POLICY
 * (undefined fields keep the default).
 */
export const resolveReconnectPolicy = (
  policy: ReconnectPolicy = {},
): Required<ReconnectPolicy> => {
  const resolved = { ...DEFAULT_RECONNECT_POLICY };
  for (const [key, value] of Object.entries(policy)) {
    if (value !== undefined) {
      resolved[key as keyof ReconnectPolicy] = value;
    }
  }
  resolved.jitter = Math.min(1, Math.max(0, resolved.jitter));
  return resolved;
};

/**
 * Delay (ms) before reconnect attempt `attempt` (0-based): exponential
 * growth capped at maxDelayMs, then jittered down by up to `jitter`.
 */
export const reconnectDelay = (
  attempt: number,
  policy: ReconnectPolicy = {},
  random: () => number = Math.random,
): number => {
  const { initialDelayMs, maxDelayMs, multiplier, jitter } =
    resolveReconnectPolicy(policy);
  const base = Math.min(
    maxDelayMs,
    initialDelayMs * multiplier ** Math.max(0, attempt),
  );
  return Math.round(base * (1 - jitter * random()));
};

/**
 * The policy as an iterable of delays in seconds, the shape of
 * VuuConnectionRegistry's `retryIntervals`. Each iteration (one reconnect
 * episode) draws fresh jitter. Infinite unless `maxAttempts` is finite.
 */
export const reconnectSchedule = (
  policy: ReconnectPolicy = {},
  random: () => number = Math.random,
): Iterable<number> => {
  const { maxAttempts } = resolveReconnectPolicy(policy);
  return {
    *[Symbol.iterator]() {
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        yield reconnectDelay(attempt, policy, random) / 1_000;
      }
    },
  };
};
