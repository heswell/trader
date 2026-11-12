/**
 * Session time and the intraday volume curve, shared by exchange-sim (which
 * scales bot activity by the curve) and the OMS (whose VWAP strategy follows
 * the same curve).
 *
 * "Clock" times are ms since the epoch. "Session" times are the time of day
 * of the (possibly compressed) trading day: with `dayMs` < 24h a whole
 * simulated day passes in `dayMs` ms of clock time, so session durations are
 * scaled by `dayMs / DAY_MS` when converted to clock durations.
 */

export const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

/**
 * Shape of the intraday volume curve over the continuous session. The
 * activity multiplier at session fraction f (0 = open, 1 = close) is
 * `base + curve * (2f - 1)^2 + openSpike * e^(-f/width) + closeSpike * e^(-(1-f)/width)`,
 * normalised to average 1 over the session.
 */
export interface VolumeProfileParams {
  base: number;
  /** U-shape: extra weight towards both ends of the session. */
  curve: number;
  /** Extra activity just after the open. */
  openSpike: number;
  /** Extra activity just before the close. */
  closeSpike: number;
  /** Width of the open / close spikes, as a fraction of the session. */
  spikeWidth: number;
}

/** A typical equity day: busy open, quiet lunch, busiest into the close. */
export const U_SHAPED_PROFILE: VolumeProfileParams = Object.freeze({
  base: 0.6,
  curve: 1.2,
  openSpike: 1.0,
  closeSpike: 1.5,
  spikeWidth: 0.03,
});

/** Constant activity: VWAP over a flat profile is TWAP. */
export const FLAT_PROFILE: VolumeProfileParams = Object.freeze({
  base: 1,
  curve: 0,
  openSpike: 0,
  closeSpike: 0,
  spikeWidth: 1,
});

export const VOLUME_PROFILES = Object.freeze({
  flat: FLAT_PROFILE,
  u: U_SHAPED_PROFILE,
});
export type VolumeProfileName = keyof typeof VOLUME_PROFILES;

const clamp01 = (f: number) => Math.min(1, Math.max(0, f));

/** Integral of the un-normalised profile over [0, f]. */
const integral = (f: number, p: VolumeProfileParams) => {
  const w = p.spikeWidth;
  return (
    p.base * f +
    (p.curve * ((2 * f - 1) ** 3 + 1)) / 6 +
    p.openSpike * w * (1 - Math.exp(-f / w)) +
    p.closeSpike * w * (Math.exp(-(1 - f) / w) - Math.exp(-1 / w))
  );
};

/** Activity multiplier at session fraction f, averaging 1 over the session. */
export const volumeProfile = (f: number, p: VolumeProfileParams): number => {
  const x = clamp01(f);
  const w = p.spikeWidth;
  const raw =
    p.base +
    p.curve * (2 * x - 1) ** 2 +
    p.openSpike * Math.exp(-x / w) +
    p.closeSpike * Math.exp(-(1 - x) / w);
  return raw / integral(1, p);
};

/** Share of the session's volume traded by session fraction f (0..1). */
export const cumulativeVolume = (f: number, p: VolumeProfileParams): number =>
  integral(clamp01(f), p) / integral(1, p);

/** The exchange's trading day, as the OMS sees it. */
export interface SessionSchedule {
  /** False = no schedule: the market is always open. */
  scheduled: boolean;
  /** Clock ms per (simulated) 24h day; DAY_MS for a real day. */
  dayMs: number;
  /** Continuous session open / close, clock ms after the start of the day. */
  openAt: number;
  closeAt: number;
  /** Intraday volume curve the exchange bots follow. */
  profile: VolumeProfileParams;
}

const mod = (n: number, m: number) => ((n % m) + m) % m;

/** Session length in clock ms (0 when unscheduled). */
const sessionLength = (s: SessionSchedule) =>
  s.scheduled ? mod(s.closeAt - s.openAt, s.dayMs) || s.dayMs : 0;

/** Clock time of the most recent session open at or before `now`. */
const lastOpenAt = (s: SessionSchedule, now: number) =>
  now - mod(mod(now, s.dayMs) - s.openAt, s.dayMs);

/** Whether the continuous session is open at `now` (always true when unscheduled). */
export const isSessionOpen = (s: SessionSchedule, now: number) =>
  !s.scheduled || now - lastOpenAt(s, now) < sessionLength(s);

/**
 * Fraction of the current continuous session elapsed at `now`: 0..1 while
 * open, undefined while closed or when there is no schedule.
 */
export const sessionFraction = (
  s: SessionSchedule,
  now: number,
): number | undefined => {
  if (!s.scheduled) return undefined;
  const elapsed = now - lastOpenAt(s, now);
  const length = sessionLength(s);
  return elapsed < length ? elapsed / length : undefined;
};

/**
 * Whether a continuous session close fell in (since, now]: a DAY order
 * entered at `since` has seen the end of its day. Always false when
 * unscheduled.
 */
export const sessionClosedSince = (
  s: SessionSchedule,
  since: number,
  now: number,
) => {
  if (!s.scheduled || now <= since) return false;
  if (now - since >= s.dayMs) return true;
  const lastCloseAt = now - mod(mod(now, s.dayMs) - s.closeAt, s.dayMs);
  return lastCloseAt > since;
};

/** Clock time of the next session open strictly after `now` (undefined = unscheduled). */
export const nextOpenAt = (s: SessionSchedule, now: number) =>
  s.scheduled ? lastOpenAt(s, now) + s.dayMs : undefined;

/**
 * Clock time of the close of the session open at `now`, or of the next
 * session when closed (undefined = unscheduled).
 */
export const sessionCloseAt = (s: SessionSchedule, now: number) => {
  if (!s.scheduled) return undefined;
  const open = lastOpenAt(s, now);
  const close = open + sessionLength(s);
  return now < close ? close : close + s.dayMs;
};

/**
 * Clock open / close of the session open at `now`, or of the next session
 * when closed (undefined = unscheduled).
 */
export const sessionWindow = (
  s: SessionSchedule,
  now: number,
): { openAt: number; closeAt: number } | undefined => {
  if (!s.scheduled) return undefined;
  const length = sessionLength(s);
  let open = lastOpenAt(s, now);
  if (now - open >= length) open += s.dayMs;
  return { openAt: open, closeAt: open + length };
};

/**
 * Activity multiplier the exchange bots apply at `now`: the volume curve
 * while the session is open, 1 otherwise (and always 1 when unscheduled).
 */
export const activityAt = (s: SessionSchedule, now: number) => {
  const f = sessionFraction(s, now);
  return f === undefined ? 1 : volumeProfile(f, s.profile);
};

/** Convert a duration in session (simulated) ms to clock ms. */
export const sessionToClockMs = (s: SessionSchedule, sessionMs: number) =>
  (sessionMs * s.dayMs) / DAY_MS;

/** Session time of day at `now`, in minutes after midnight. */
export const sessionMinuteOfDay = (s: SessionSchedule, now: number) =>
  (mod(now, s.dayMs) * DAY_MS) / s.dayMs / MINUTE_MS;

/**
 * Clock time at which the session clock next reads `minuteOfDay`
 * (minutes after midnight), at or after `now`.
 */
export const clockAtSessionMinute = (
  s: SessionSchedule,
  now: number,
  minuteOfDay: number,
) => {
  const target = (mod(minuteOfDay, 1440) * MINUTE_MS * s.dayMs) / DAY_MS;
  return now + mod(target - mod(now, s.dayMs), s.dayMs);
};

/** Schedule of an always-open market (no session, flat profile). */
export const UNSCHEDULED: SessionSchedule = Object.freeze({
  scheduled: false,
  dayMs: DAY_MS,
  openAt: 0,
  closeAt: 0,
  profile: FLAT_PROFILE,
});
