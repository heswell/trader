import { TradingPhase } from "@heswell/trading-schemas";

/** Phases driven by the market-wide session schedule. */
export type SessionPhase =
  | typeof TradingPhase.PreOpen
  | typeof TradingPhase.Continuous
  | typeof TradingPhase.Closed;

export const SESSION_PHASES: readonly SessionPhase[] = Object.freeze([
  TradingPhase.PreOpen,
  TradingPhase.Continuous,
  TradingPhase.Closed,
]);

export interface TradingSessionConfig {
  /** "HH:MM" UTC; "" (with sessionClose "") = no schedule. */
  sessionOpen: string;
  /** "HH:MM" UTC; may be earlier than sessionOpen for an overnight session. */
  sessionClose: string;
  /** Minutes of PRE_OPEN before sessionOpen. */
  preOpenMinutes: number;
  /** 0 = real 24h day; > 0 = the 24h schedule is compressed into this many ms. */
  sessionDayMs: number;
}

export const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
/** Default hours used by a fast simulated day when open/close are unset. */
export const DEFAULT_SIM_DAY_OPEN = "08:00";
export const DEFAULT_SIM_DAY_CLOSE = "16:30";

const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Parse "HH:MM" to minutes after midnight, or undefined if malformed. */
export const parseTimeOfDay = (value: string): number | undefined => {
  const match = HH_MM.exec(value.trim());
  return match ? Number(match[1]) * 60 + Number(match[2]) : undefined;
};

/** Throws if the session settings are inconsistent; used by validateConfig. */
export const validateSessionConfig = (config: TradingSessionConfig) => {
  const { sessionOpen, sessionClose, preOpenMinutes, sessionDayMs } = config;
  if (!(sessionDayMs >= 0))
    throw Error("exchangeSim.sessionDayMs must be >= 0");
  if (!(preOpenMinutes >= 0)) {
    throw Error("exchangeSim.preOpenMinutes must be >= 0");
  }
  if ((sessionOpen === "") !== (sessionClose === "")) {
    throw Error(
      "exchangeSim.sessionOpen and exchangeSim.sessionClose must be set together",
    );
  }
  if (sessionOpen === "") return;
  const open = parseTimeOfDay(sessionOpen);
  const close = parseTimeOfDay(sessionClose);
  if (open === undefined) {
    throw Error(`exchangeSim.sessionOpen '${sessionOpen}' is not HH:MM (UTC)`);
  }
  if (close === undefined) {
    throw Error(
      `exchangeSim.sessionClose '${sessionClose}' is not HH:MM (UTC)`,
    );
  }
  if (open === close) {
    throw Error("exchangeSim.sessionOpen and sessionClose must differ");
  }
  const sessionMinutes = (close - open + 1440) % 1440;
  if (sessionMinutes + preOpenMinutes >= 1440) {
    throw Error(
      "exchangeSim.preOpenMinutes leaves no CLOSED period in the session day",
    );
  }
};

const mod = (n: number, m: number) => ((n % m) + m) % m;

/**
 * Pure market-wide session schedule: CLOSED -> PRE_OPEN -> CONTINUOUS ->
 * CLOSED, repeating every day. Times are UTC time-of-day of the clock (the
 * clock is ms since the epoch, so day boundaries are UTC midnights). With
 * `sessionDayMs > 0` the 24h schedule is compressed into that many ms of
 * clock time (aligned to multiples of sessionDayMs since the epoch). With
 * no schedule the market is always CONTINUOUS.
 */
export class TradingSession {
  /** Day length in clock ms. */
  readonly dayMs: number;
  /** Boundaries within the day, in clock ms after the start of the day. */
  readonly #preOpenAt: number;
  readonly #openAt: number;
  readonly #closeAt: number;
  readonly scheduled: boolean;

  constructor(config: TradingSessionConfig) {
    validateSessionConfig(config);
    const { sessionDayMs, preOpenMinutes } = config;
    let { sessionOpen, sessionClose } = config;
    if (sessionOpen === "" && sessionDayMs > 0) {
      sessionOpen = DEFAULT_SIM_DAY_OPEN;
      sessionClose = DEFAULT_SIM_DAY_CLOSE;
    }
    this.scheduled = sessionOpen !== "";
    this.dayMs = sessionDayMs > 0 ? sessionDayMs : DAY_MS;
    const scale = this.dayMs / DAY_MS;
    const toClock = (minutes: number) => mod(minutes, 1440) * MINUTE_MS * scale;
    const open = parseTimeOfDay(sessionOpen) ?? 0;
    const close = parseTimeOfDay(sessionClose) ?? 0;
    this.#openAt = toClock(open);
    this.#closeAt = toClock(close);
    this.#preOpenAt = toClock(open - preOpenMinutes);
  }

  /** Clock ms since the start of the (possibly compressed) day. */
  #timeOfDay(now: number) {
    return mod(now, this.dayMs);
  }

  /** True if t lies in [start, end) on the day circle. */
  #within(t: number, start: number, end: number) {
    return start <= end ? t >= start && t < end : t >= start || t < end;
  }

  phaseAt(now: number): SessionPhase {
    if (!this.scheduled) return TradingPhase.Continuous;
    const t = this.#timeOfDay(now);
    if (this.#within(t, this.#openAt, this.#closeAt)) {
      return TradingPhase.Continuous;
    }
    if (
      this.#preOpenAt !== this.#openAt &&
      this.#within(t, this.#preOpenAt, this.#openAt)
    ) {
      return TradingPhase.PreOpen;
    }
    return TradingPhase.Closed;
  }

  /** Clock time of the next phase change strictly after `now` (undefined = never). */
  nextChangeAt(now: number): number | undefined {
    if (!this.scheduled) return undefined;
    const t = this.#timeOfDay(now);
    const current = this.phaseAt(now);
    let best: number | undefined;
    for (const boundary of [this.#preOpenAt, this.#openAt, this.#closeAt]) {
      const delta = mod(boundary - t, this.dayMs) || this.dayMs;
      // A boundary in the same instant as the current one may not change phase
      // (e.g. preOpenMinutes 0), so check the phase reached there.
      const at = now + delta;
      if (this.phaseAt(Math.ceil(at)) === current) continue;
      if (best === undefined || at < best) best = at;
    }
    return best === undefined ? undefined : Math.ceil(best);
  }
}
