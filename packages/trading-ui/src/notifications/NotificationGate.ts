import {
  orderEventKey,
  type TradingOrderEvent,
  type TradingOrderEventKind,
} from "./tradingOrderEvents";

export interface RateLimit {
  /** Max notifications shown per window. */
  max: number;
  /** Window length (ms). */
  perMs: number;
}

export interface NotificationGateOptions {
  /** Drop an event with the same key seen within this period (ms). */
  dedupeMs?: number;
  rateLimit?: RateLimit;
  /** Called for each event allowed through. */
  emit: (event: TradingOrderEvent) => void;
  /**
   * Called once per window in which events were suppressed by the rate
   * limit, with the suppressed count by kind.
   */
  emitSummary: (
    suppressed: Partial<Record<TradingOrderEventKind, number>>,
  ) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

export const DEFAULT_RATE_LIMIT: RateLimit = Object.freeze({
  max: 4,
  perMs: 1_000,
});
export const DEFAULT_DEDUPE_MS = 30_000;

/**
 * Dedupe + rate limiting for notifications. The same event can arrive from
 * the submitting component (RPC result) and from the parentOrders / fills
 * streams; bursts (cancelAll, a sweep filling many orders) collapse into a
 * summary after `rateLimit.max` per window.
 */
export class NotificationGate {
  readonly #emit: NotificationGateOptions["emit"];
  readonly #emitSummary: NotificationGateOptions["emitSummary"];
  readonly #now: () => number;
  readonly #setTimer: (fn: () => void, ms: number) => unknown;
  readonly #clearTimer: (timer: unknown) => void;
  dedupeMs: number;
  rateLimit: RateLimit;
  #seen = new Map<string, number>();
  #shown: number[] = [];
  #suppressed: Partial<Record<TradingOrderEventKind, number>> = {};
  #timer: unknown;

  constructor({
    dedupeMs = DEFAULT_DEDUPE_MS,
    rateLimit = DEFAULT_RATE_LIMIT,
    emit,
    emitSummary,
    now = Date.now,
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  }: NotificationGateOptions) {
    this.dedupeMs = dedupeMs;
    this.rateLimit = rateLimit;
    this.#emit = emit;
    this.#emitSummary = emitSummary;
    this.#now = now;
    this.#setTimer = setTimer;
    this.#clearTimer = clearTimer;
  }

  /** Returns true if the event was shown, false if dropped or suppressed. */
  offer(event: TradingOrderEvent): boolean {
    const now = this.#now();
    const key = orderEventKey(event);
    const seenAt = this.#seen.get(key);
    if (seenAt !== undefined && now - seenAt < this.dedupeMs) return false;
    this.#seen.set(key, now);
    if (this.#seen.size > 1_000) this.#prune(now);

    const windowStart = now - this.rateLimit.perMs;
    while (this.#shown.length && this.#shown[0] <= windowStart) {
      this.#shown.shift();
    }
    if (this.#shown.length >= this.rateLimit.max) {
      this.#suppressed[event.kind] = (this.#suppressed[event.kind] ?? 0) + 1;
      this.#timer ??= this.#setTimer(
        () => this.flush(),
        this.#shown[0] + this.rateLimit.perMs - now,
      );
      return false;
    }
    this.#shown.push(now);
    this.#emit(event);
    return true;
  }

  /** Emit the summary of suppressed events now (if any). */
  flush() {
    if (this.#timer !== undefined) {
      this.#clearTimer(this.#timer);
      this.#timer = undefined;
    }
    const suppressed = this.#suppressed;
    if (Object.keys(suppressed).length > 0) {
      this.#suppressed = {};
      this.#shown.push(this.#now());
      this.#emitSummary(suppressed);
    }
  }

  dispose() {
    if (this.#timer !== undefined) this.#clearTimer(this.#timer);
    this.#timer = undefined;
  }

  #prune(now: number) {
    for (const [key, at] of this.#seen) {
      if (now - at >= this.dedupeMs) this.#seen.delete(key);
    }
  }
}
