import { optionAnalytics as optionAnalyticsDef } from "@heswell/trading-schemas";
import type { OptionValue } from "../engine/OptionPricer";
import { type PublishTable, RowLayout, round } from "./rows";

/** One option's analytics, as the simulator computed them on a flush. */
export interface OptionAnalytics {
  ric: string;
  underlying: string;
  value: OptionValue;
  /** Vol implied by the book's (or the theoretical quote's) mid. */
  impliedVol: number | undefined;
}

const DAYS_PER_YEAR = 365;

/** Rounded, with -0 (a tiny negative Greek) published as 0. */
const fixed = (value: number, decimals: number) => round(value, decimals) || 0;

/**
 * Publishes `optionAnalytics` rows (model value and Greeks per option) at
 * most every `intervalMs`: `due(now)` says when, `publish` writes them.
 */
export class OptionAnalyticsPublisher {
  readonly #layout: RowLayout<typeof optionAnalyticsDef>;
  #next = 0;
  rowsWritten = 0;

  constructor(
    readonly table: PublishTable,
    readonly intervalMs: number,
    /** √timeScale: impliedVol / volScale is the base (model-time) vol. */
    readonly volScale: number,
  ) {
    this.#layout = new RowLayout(table, optionAnalyticsDef, null);
  }

  due(now: number) {
    return this.intervalMs > 0 && now >= this.#next;
  }

  /** Drop an option's row (it has expired). */
  remove(ric: string) {
    if (this.table.rowIndexAtKey(ric) >= 0) this.table.delete(ric);
  }

  publish(rows: Iterable<OptionAnalytics>, now: number) {
    this.#next = now + this.intervalMs;
    const { idx } = this.#layout;
    for (const { ric, underlying, value, impliedVol } of rows) {
      const row = this.#layout.row();
      row[idx.ric] = ric;
      row[idx.underlying] = underlying;
      row[idx.forward] = fixed(value.forward, 6);
      row[idx.theo] = fixed(value.price, 6);
      row[idx.modelVol] = fixed(value.vol, 6);
      row[idx.impliedVol] =
        impliedVol === undefined ? null : fixed(impliedVol, 6);
      row[idx.baseVol] =
        impliedVol === undefined ? null : fixed(impliedVol / this.volScale, 6);
      row[idx.delta] = fixed(value.delta, 6);
      row[idx.gamma] = fixed(value.gamma, 8);
      row[idx.vega] = fixed(value.vega / 100, 6);
      row[idx.theta] = fixed(value.theta / DAYS_PER_YEAR, 6);
      row[idx.timestamp] = now;
      const rowIdx = this.table.rowIndexAtKey(ric);
      if (rowIdx === -1) this.table.insert(row);
      else this.table.update(rowIdx, row);
      this.rowsWritten++;
    }
  }
}
