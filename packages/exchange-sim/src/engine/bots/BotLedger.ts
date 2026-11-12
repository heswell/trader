import { Side as BookSide, type Trade } from "@heswell/hft-limit-order-book";

/** Persisted part of a ledger (see BookState.bots). */
export interface BotLedgerState {
  orders: number;
  modifies: number;
  cancels: number;
  fills: number;
  makerFills: number;
  boughtQty: number;
  soldQty: number;
  notional: number;
  position: number;
  avgPrice: number;
  cash: number;
  realisedPnl: number;
}

/**
 * One bot's trading record: order counts, fills, position and P&L in the
 * instrument's price currency, excluding the contract multiplier (callers
 * convert to USD with usdPerUnit). Updated by the bot's OrderPort, never by the bot.
 */
export class BotLedger implements BotLedgerState {
  orders = 0;
  modifies = 0;
  cancels = 0;
  fills = 0;
  makerFills = 0;
  boughtQty = 0;
  soldQty = 0;
  /** Sum of price * size over all fills. */
  notional = 0;
  /** Signed quantity held (long > 0). */
  position = 0;
  /** Average cost of the open position (0 when flat). */
  avgPrice = 0;
  /** Sale proceeds minus purchase costs. */
  cash = 0;
  realisedPnl = 0;

  get volume() {
    return this.boughtQty + this.soldQty;
  }

  get takerFills() {
    return this.fills - this.makerFills;
  }

  /** Mark-to-market P&L of the open position. */
  unrealisedPnl(mark: number) {
    if (this.position === 0 || !(mark > 0)) return 0;
    return (mark - this.avgPrice) * this.position;
  }

  totalPnl(mark: number) {
    return this.realisedPnl + this.unrealisedPnl(mark);
  }

  /**
   * Record a fill. `trade.side` is the aggressor's side, so a maker fill is
   * on the opposite side.
   */
  recordFill(trade: Trade, isMaker: boolean) {
    const { price, size } = trade;
    const buy = (trade.side === BookSide.BUY) !== isMaker;
    this.fills++;
    if (isMaker) this.makerFills++;
    this.notional += price * size;
    const signed = buy ? size : -size;
    if (buy) {
      this.boughtQty += size;
      this.cash -= price * size;
    } else {
      this.soldQty += size;
      this.cash += price * size;
    }
    const before = this.position;
    const after = before + signed;
    if (before === 0 || Math.sign(before) === Math.sign(signed)) {
      // opening or adding: new average cost
      this.avgPrice =
        (this.avgPrice * Math.abs(before) + price * size) / Math.abs(after);
    } else {
      // reducing, closing or flipping
      const closed = Math.min(Math.abs(before), size);
      this.realisedPnl += (price - this.avgPrice) * closed * Math.sign(before);
      if (after === 0) this.avgPrice = 0;
      else if (Math.sign(after) !== Math.sign(before)) this.avgPrice = price;
    }
    this.position = after;
  }

  /**
   * Start the stats again (resetBotStats): counters and realised P&L go to
   * zero, and an open position is re-marked at `mark`, so P&L counts from
   * now (cash + position × mark stays the total).
   */
  reset(mark: number) {
    this.orders = 0;
    this.modifies = 0;
    this.cancels = 0;
    this.fills = 0;
    this.makerFills = 0;
    this.boughtQty = 0;
    this.soldQty = 0;
    this.notional = 0;
    this.realisedPnl = 0;
    this.avgPrice = this.position === 0 ? 0 : mark;
    this.cash = -this.position * mark;
  }

  exportState(): BotLedgerState {
    const {
      orders,
      modifies,
      cancels,
      fills,
      makerFills,
      boughtQty,
      soldQty,
      notional,
      position,
      avgPrice,
      cash,
      realisedPnl,
    } = this;
    return {
      orders,
      modifies,
      cancels,
      fills,
      makerFills,
      boughtQty,
      soldQty,
      notional,
      position,
      avgPrice,
      cash,
      realisedPnl,
    };
  }

  restoreState(state: Partial<BotLedgerState>) {
    for (const key of Object.keys(state) as (keyof BotLedgerState)[]) {
      const value = state[key];
      if (typeof value === "number" && Number.isFinite(value))
        this[key] = value;
    }
  }
}
