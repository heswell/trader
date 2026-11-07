import { Histogram } from "./Histogram";

/**
 * How timers sample:
 * - `off`: calls are counted, nothing is timed;
 * - `sampled`: one call in `sampleEvery` is timed;
 * - `all`: every call is timed.
 */
export type TimerMode = "off" | "sampled" | "all";

export const TIMER_MODES: readonly TimerMode[] = ["off", "sampled", "all"];

/** Returned by `start()` when the call is not timed. */
const NOT_TIMED = -1;

const isPowerOfTwo = (n: number) =>
  Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;

/**
 * A hot-path latency timer. Every call is counted; the sampled ones are
 * recorded (in µs) into a fixed-size histogram that the metrics collector
 * reads and resets once per interval. Allocation-free:
 *
 * ```ts
 * const t0 = timer.start();
 * doWork();
 * timer.stop(t0);
 * ```
 *
 * An untimed call costs an increment and a compare; a timed call adds two
 * `performance.now()` reads and a histogram record.
 */
export class Timer {
  readonly histogram = new Histogram();
  /** Calls since start (timed or not). */
  calls = 0;
  /** Sampling mask: a call is timed when (calls & mask) === 0. */
  #mask = 0;
  #on = false;

  constructor(mode: TimerMode = "off", sampleEvery = 16) {
    this.setMode(mode, sampleEvery);
  }

  /** `sampleEvery` must be a power of two (used for `sampled` only). */
  setMode(mode: TimerMode, sampleEvery = 16) {
    if (!isPowerOfTwo(sampleEvery))
      throw Error(
        `timer sampleEvery must be a power of two, got ${sampleEvery}`,
      );
    this.#on = mode !== "off";
    this.#mask = mode === "sampled" ? sampleEvery - 1 : 0;
  }

  get mode(): TimerMode {
    return !this.#on ? "off" : this.#mask === 0 ? "all" : "sampled";
  }

  /** Count a call; returns its start time when it is timed, else -1. */
  start(): number {
    const n = ++this.calls;
    return this.#on && (n & this.#mask) === 0 ? performance.now() : NOT_TIMED;
  }

  /** End a call started with `start()` (a no-op when it was not timed). */
  stop(t0: number) {
    if (t0 >= 0) this.histogram.record((performance.now() - t0) * 1_000);
  }

  /**
   * Count a call and, when it is sampled, record a latency measured some
   * other way (µs), e.g. an order's create-to-fill time from its timestamps.
   */
  record(us: number) {
    const n = ++this.calls;
    if (this.#on && (n & this.#mask) === 0) this.histogram.record(us);
  }
}

/** A component's timer in a registry. */
export interface RegisteredTimer {
  component: string;
  name: string;
  unit: string;
  timer: Timer;
}

/**
 * The timers of one part of the server (e.g. the exchange simulator), so
 * their mode can be set together and a metrics source can report them all.
 * New timers take the registry's current mode.
 */
export class TimerRegistry {
  readonly #timers = new Map<string, RegisteredTimer>();
  #mode: TimerMode;
  #sampleEvery: number;

  constructor(mode: TimerMode = "off", sampleEvery = 16) {
    new Timer(mode, sampleEvery); // validates
    this.#mode = mode;
    this.#sampleEvery = sampleEvery;
  }

  /** The timer `component.name`, created on first use. */
  timer(component: string, name: string, unit = "us"): Timer {
    const id = `${component}.${name}`;
    let entry = this.#timers.get(id);
    if (!entry) {
      entry = {
        component,
        name,
        unit,
        timer: new Timer(this.#mode, this.#sampleEvery),
      };
      this.#timers.set(id, entry);
    }
    return entry.timer;
  }

  setMode(mode: TimerMode, sampleEvery = this.#sampleEvery) {
    for (const { timer } of this.#timers.values())
      timer.setMode(mode, sampleEvery);
    this.#mode = mode;
    this.#sampleEvery = sampleEvery;
  }

  get mode() {
    return this.#mode;
  }

  get sampleEvery() {
    return this.#sampleEvery;
  }

  timers(): Iterable<RegisteredTimer> {
    return this.#timers.values();
  }
}
