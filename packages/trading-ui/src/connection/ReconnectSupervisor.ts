import {
  type ReconnectPolicy,
  reconnectDelay,
  resolveReconnectPolicy,
} from "./reconnectPolicy";

export type SupervisorState =
  | "idle"
  | "connected"
  | "reconnecting"
  | "failed"
  | "stopped";

export interface SupervisorSnapshot {
  state: SupervisorState;
  /** Failed attempts in the current episode. */
  attempt: number;
  /** When the next attempt is due (ms since epoch), while reconnecting. */
  nextAttemptAt?: number;
  error?: Error;
}

export interface ReconnectTimers {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  now: () => number;
}

export interface ReconnectSupervisorOptions {
  /** One attempt: resolve when connected, reject (or throw) on failure. */
  connect: () => Promise<void>;
  policy?: ReconnectPolicy;
  onChange?: (snapshot: SupervisorSnapshot) => void;
  /** Injected for tests. */
  random?: () => number;
  timers?: ReconnectTimers;
}

const defaultTimers: ReconnectTimers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) =>
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

const toError = (err: unknown) =>
  err instanceof Error ? err : new Error(String(err));

/**
 * The reconnect state machine for a connection trader opens itself
 * (connectToVuuServer). Under the portal VuuConnectionRegistry owns the
 * loop instead (createResilientConnectionRegistry).
 *
 *   idle --connected()--> connected --connectionLost()--> reconnecting
 *   reconnecting --attempt ok--> connected
 *   reconnecting --attempt failed--> reconnecting (backoff + jitter)
 *                                --maxAttempts reached--> failed
 *   failed --retryNow() / connectionLost()--> reconnecting
 *   any --stop()--> stopped (terminal)
 *
 * Only one attempt runs at a time; connectionLost() while reconnecting is
 * ignored, so the socket's own "disconnected" events during an attempt do
 * not multiply attempts.
 */
export class ReconnectSupervisor {
  #attempt = 0;
  #connect: () => Promise<void>;
  #error?: Error;
  #inFlight = false;
  #nextAttemptAt?: number;
  #onChange?: (snapshot: SupervisorSnapshot) => void;
  #policy: Required<ReconnectPolicy>;
  #random: () => number;
  #state: SupervisorState = "idle";
  #timer: unknown;
  #timers: ReconnectTimers;

  constructor({
    connect,
    onChange,
    policy,
    random = Math.random,
    timers = defaultTimers,
  }: ReconnectSupervisorOptions) {
    this.#connect = connect;
    this.#onChange = onChange;
    this.#policy = resolveReconnectPolicy(policy);
    this.#random = random;
    this.#timers = timers;
  }

  get state() {
    return this.#state;
  }

  get snapshot(): SupervisorSnapshot {
    return {
      state: this.#state,
      attempt: this.#attempt,
      nextAttemptAt: this.#nextAttemptAt,
      error: this.#error,
    };
  }

  /** The connection is up (initial connect, or established elsewhere). */
  connected() {
    if (this.#state === "stopped") return;
    this.#clearTimer();
    this.#attempt = 0;
    this.#error = undefined;
    this.#setState("connected");
  }

  /** The socket dropped: start a reconnect episode unless one is running. */
  connectionLost(error?: unknown) {
    if (this.#state === "reconnecting" || this.#state === "stopped") return;
    this.#attempt = 0;
    if (error !== undefined) this.#error = toError(error);
    this.#setState("reconnecting");
    this.#schedule();
  }

  /** Attempt now (e.g. a "Retry now" button), skipping the backoff. */
  retryNow() {
    if (this.#state === "stopped" || this.#state === "connected") return;
    if (this.#inFlight) return;
    if (this.#state !== "reconnecting") {
      this.#attempt = 0;
      this.#setState("reconnecting");
    }
    this.#clearTimer();
    void this.#run();
  }

  stop() {
    this.#clearTimer();
    this.#setState("stopped");
  }

  #schedule() {
    this.#clearTimer();
    const delay = reconnectDelay(this.#attempt, this.#policy, this.#random);
    this.#nextAttemptAt = this.#timers.now() + delay;
    this.#emit();
    this.#timer = this.#timers.setTimeout(() => {
      this.#timer = undefined;
      void this.#run();
    }, delay);
  }

  async #run() {
    if (this.#state !== "reconnecting" || this.#inFlight) return;
    this.#inFlight = true;
    this.#nextAttemptAt = undefined;
    try {
      await this.#connect();
      this.#inFlight = false;
      if (this.#state === "reconnecting") this.connected();
    } catch (err) {
      this.#inFlight = false;
      if (this.#state !== "reconnecting") return;
      this.#error = toError(err);
      this.#attempt += 1;
      if (this.#attempt >= this.#policy.maxAttempts) {
        this.#setState("failed");
      } else {
        this.#schedule();
      }
    }
  }

  #clearTimer() {
    if (this.#timer !== undefined) {
      this.#timers.clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    this.#nextAttemptAt = undefined;
  }

  #setState(state: SupervisorState) {
    if (this.#state === state) return;
    this.#state = state;
    this.#emit();
  }

  #emit() {
    this.#onChange?.(this.snapshot);
  }
}
