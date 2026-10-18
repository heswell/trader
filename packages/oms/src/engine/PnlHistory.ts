import { accountPnlHistoryKey, pnlHistoryKey } from "@heswell/trading-schemas";
import type { Position } from "./OmsEngine";

export interface PnlHistoryRow {
  id: string;
  account: string;
  ric: string;
  time: number;
  quantity: number;
  avgCost: number;
  markPx: number;
  marketValue: number;
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
  grossExposure: number;
  netExposure: number;
  totalPnlUsd: number;
  marketValueUsd: number;
  currency: string;
}

export interface AccountPnlHistoryRow {
  id: string;
  account: string;
  time: number;
  positions: number;
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
  grossExposure: number;
  netExposure: number;
}

/** Where P&L history rows go (TableSink, or a test double). */
export interface PnlHistorySink {
  pnlHistory?(row: PnlHistoryRow): void;
  accountPnlHistory?(row: AccountPnlHistoryRow): void;
  deleteRow?(table: "pnlHistory" | "accountPnlHistory", key: string): void;
}

export interface PnlHistoryOptions {
  /** Sample interval (ms); sample times are aligned to multiples of it. */
  intervalMs: number;
  /** Samples kept per position and per account (oldest deleted). */
  length: number;
  /** USD value of one price unit of a ric (GBX is in pence); 1 if unknown. */
  usdPerPriceUnit: (ric: string) => number;
}

const money = (value: number) => Math.round(value * 100) / 100;

interface Sampled {
  quantity: number;
  markPx: number;
  realizedPnl: number;
}

/**
 * Periodic P&L snapshots, driven by the mark timer (OmsService.mark). Each
 * sample writes a pnlHistory row per position that changed since its last
 * sample (quantity, mark or realised P&L), so a position's rows form a step
 * series, plus an accountPnlHistory row (USD totals) for every account with
 * positions. Both keep `length` rows per key, deleting the oldest.
 */
export class PnlHistory {
  readonly #positionKeys = new Map<string, string[]>();
  readonly #accountKeys = new Map<string, string[]>();
  readonly #last = new Map<string, Sampled>();
  #nextAt = 0;
  rowsWritten = 0;
  rowsDeleted = 0;

  constructor(
    readonly sink: PnlHistorySink,
    readonly options: PnlHistoryOptions,
  ) {}

  /** True when a sample is due at `now` (advances the schedule). */
  due(now: number) {
    if (now < this.#nextAt) return false;
    const { intervalMs } = this.options;
    this.#nextAt = (Math.floor(now / intervalMs) + 1) * intervalMs;
    return true;
  }

  /** Rows kept (pnlHistory + accountPnlHistory). */
  get rowCount() {
    let count = 0;
    for (const keys of this.#positionKeys.values()) count += keys.length;
    for (const keys of this.#accountKeys.values()) count += keys.length;
    return count;
  }

  #keep(
    table: "pnlHistory" | "accountPnlHistory",
    index: Map<string, string[]>,
    id: string,
    key: string,
  ) {
    let keys = index.get(id);
    if (!keys) {
      keys = [];
      index.set(id, keys);
    }
    keys.push(key);
    this.rowsWritten++;
    if (keys.length > this.options.length) {
      this.sink.deleteRow?.(table, keys.shift() as string);
      this.rowsDeleted++;
    }
  }

  /** Write one sample at `now` (aligned down to the interval). */
  sample(now: number, positions: Iterable<Position>) {
    const { intervalMs, usdPerPriceUnit } = this.options;
    const time = Math.floor(now / intervalMs) * intervalMs;
    const totals = new Map<string, AccountPnlHistoryRow>();
    for (const p of positions) {
      const usd = usdPerPriceUnit(p.ric);
      let total = totals.get(p.account);
      if (!total) {
        total = {
          id: accountPnlHistoryKey(p.account, time),
          account: p.account,
          time,
          positions: 0,
          realizedPnl: 0,
          unrealizedPnl: 0,
          totalPnl: 0,
          grossExposure: 0,
          netExposure: 0,
        };
        totals.set(p.account, total);
      }
      if (p.quantity !== 0) total.positions++;
      total.realizedPnl += p.realizedPnl * usd;
      total.unrealizedPnl += p.unrealizedPnl * usd;
      total.totalPnl += p.totalPnl * usd;
      total.grossExposure += Math.abs(p.marketValue) * usd;
      total.netExposure += p.marketValue * usd;

      const last = this.#last.get(p.id);
      if (
        last &&
        last.quantity === p.quantity &&
        last.markPx === p.markPx &&
        last.realizedPnl === p.realizedPnl
      ) {
        continue;
      }
      const id = pnlHistoryKey(p.account, p.ric, time);
      const keys = this.#positionKeys.get(p.id);
      if (keys?.at(-1) === id) continue;
      this.#last.set(p.id, {
        quantity: p.quantity,
        markPx: p.markPx,
        realizedPnl: p.realizedPnl,
      });
      this.sink.pnlHistory?.({
        id,
        account: p.account,
        ric: p.ric,
        time,
        quantity: p.quantity,
        avgCost: p.avgCost,
        markPx: p.markPx,
        marketValue: money(p.marketValue),
        realizedPnl: money(p.realizedPnl),
        unrealizedPnl: money(p.unrealizedPnl),
        totalPnl: money(p.totalPnl),
        grossExposure: money(Math.abs(p.marketValue)),
        netExposure: money(p.marketValue),
        totalPnlUsd: money(p.totalPnl * usd),
        marketValueUsd: money(p.marketValue * usd),
        currency: p.currency,
      });
      this.#keep("pnlHistory", this.#positionKeys, p.id, id);
    }
    for (const total of totals.values()) {
      if (this.#accountKeys.get(total.account)?.at(-1) === total.id) continue;
      this.sink.accountPnlHistory?.({
        ...total,
        realizedPnl: money(total.realizedPnl),
        unrealizedPnl: money(total.unrealizedPnl),
        totalPnl: money(total.totalPnl),
        grossExposure: money(total.grossExposure),
        netExposure: money(total.netExposure),
      });
      this.#keep(
        "accountPnlHistory",
        this.#accountKeys,
        total.account,
        total.id,
      );
    }
  }
}
