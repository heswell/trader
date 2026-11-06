import { Side as BookSide, type Trade } from "@heswell/hft-limit-order-book";

/** Averaging windows of the mid EMAs, in wall-clock seconds. */
export const SIGNAL_WINDOWS_SECS = Object.freeze([1, 10, 60] as const);
/** Window of the realised volatility and trade imbalance estimates (s). */
export const VOL_WINDOW_SECS = 30;
export const IMBALANCE_WINDOW_SECS = 10;

/**
 * Shared view of one instrument's recent market, updated once per step
 * (from the book as the step starts, before its bots act) and read by every
 * bot on it (none keeps its own price history). All windows are wall-clock
 * seconds. Values are NaN / 0 until the book has a two-sided
 * market.
 */
export class MarketSignals {
  /** Mid of the best bid and ask (NaN while one side is empty). */
  mid = Number.NaN;
  /** EMAs of mid, one per SIGNAL_WINDOWS_SECS entry. */
  readonly midEma: number[] = SIGNAL_WINDOWS_SECS.map(() => Number.NaN);
  /** Realised volatility of mid returns, in bps per square-root second. */
  volBpsPerSqrtSec = 0;
  /**
   * Signed aggressor volume (buys - sells) over total, EWMA over
   * IMBALANCE_WINDOW_SECS: -1 all selling .. +1 all buying.
   */
  imbalance = 0;
  lastTradePrice = Number.NaN;
  #signedVolume = 0;
  #totalVolume = 0;
  #pendingSigned = 0;
  #pendingTotal = 0;
  #varPerSec = 0;

  /** Mid return in bps against the EMA of window `i` (0 before it settles). */
  returnBps(i: number) {
    const ema = this.midEma[i];
    if (!(ema > 0) || !(this.mid > 0)) return 0;
    return ((this.mid - ema) / ema) * 1e4;
  }

  /** Called for every trade on the instrument (InstrumentBook trade listener). */
  onTrade(trade: Trade) {
    this.lastTradePrice = trade.price;
    this.#pendingTotal += trade.size;
    this.#pendingSigned +=
      trade.side === BookSide.BUY ? trade.size : -trade.size;
  }

  /** Advance by `dt` wall-clock seconds with the current best bid / ask. */
  update(dt: number, bid: number, ask: number) {
    if (dt > 0) {
      const decay = Math.exp(-dt / IMBALANCE_WINDOW_SECS);
      this.#signedVolume = this.#signedVolume * decay + this.#pendingSigned;
      this.#totalVolume = this.#totalVolume * decay + this.#pendingTotal;
      this.imbalance =
        this.#totalVolume > 0 ? this.#signedVolume / this.#totalVolume : 0;
    }
    this.#pendingSigned = 0;
    this.#pendingTotal = 0;
    if (!(bid > 0 && ask > 0)) {
      this.mid = Number.NaN;
      return;
    }
    const mid = (bid + ask) / 2;
    const previous = this.mid;
    this.mid = mid;
    if (!(previous > 0) || !(dt > 0)) {
      for (let i = 0; i < this.midEma.length; i++) {
        if (!(this.midEma[i] > 0)) this.midEma[i] = mid;
      }
      return;
    }
    for (let i = 0; i < SIGNAL_WINDOWS_SECS.length; i++) {
      const a = 1 - Math.exp(-dt / SIGNAL_WINDOWS_SECS[i]);
      this.midEma[i] += a * (mid - this.midEma[i]);
    }
    const r = Math.log(mid / previous) * 1e4;
    const a = 1 - Math.exp(-dt / VOL_WINDOW_SECS);
    this.#varPerSec += a * ((r * r) / dt - this.#varPerSec);
    this.volBpsPerSqrtSec = Math.sqrt(this.#varPerSec);
  }
}
