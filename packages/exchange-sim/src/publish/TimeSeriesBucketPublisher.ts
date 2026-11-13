import {
  RejectReason,
  type SetTimeSeriesWindowRequest,
  type SetTimeSeriesWindowResponse,
  TIME_SERIES_FIELDS,
  TIME_SERIES_LEASE_MS,
  type TimeSeriesField,
  timeSeriesBucketKey,
  timeSeriesBuckets as timeSeriesBucketsDef,
} from "@heswell/trading-schemas";
import { type BucketDiff, BucketWindow } from "../history/BucketWindow";
import {
  TimeSeriesError,
  type TimeSeriesStore,
} from "../history/TimeSeriesStore";
import { type PublishTable, RowLayout, type RowValue, round } from "./rows";

interface Subscription {
  subId: string;
  owner: string;
  ric: string;
  window: BucketWindow;
  decimals: Record<string, number>;
  /** Clock time of the last window change (lease). */
  touched: number;
}

export interface BucketPublisherStats {
  subscriptions: number;
  rows: number;
  upserts: number;
  removed: number;
}

/**
 * Publishes time-series subscriptions as `timeSeriesBuckets` rows: each
 * subscription is a BucketWindow whose diffs become row inserts, updates and
 * deletes. A client filters a viewport on its subId and so gets the buckets
 * streamed like any other rows; a tick updates one row per changed bucket,
 * coalesced by the table's publish queue.
 */
export class TimeSeriesBucketPublisher {
  readonly #subs = new Map<string, Subscription>();
  readonly #layout: RowLayout<typeof timeSeriesBucketsDef>;
  readonly stats: BucketPublisherStats = {
    subscriptions: 0,
    rows: 0,
    upserts: 0,
    removed: 0,
  };

  constructor(
    readonly table: PublishTable,
    readonly store: TimeSeriesStore,
    readonly leaseMs = TIME_SERIES_LEASE_MS,
  ) {
    this.#layout = new RowLayout(table, timeSeriesBucketsDef, 0);
  }

  get subscriptionCount() {
    return this.#subs.size;
  }

  /** Open or move `subId`'s window (validated params) at clock `now`. */
  setWindow(
    req: SetTimeSeriesWindowRequest,
    now: number,
    owner = "",
  ): SetTimeSeriesWindowResponse {
    const t0 = performance.now();
    if (!(req.end > req.start))
      throw new TimeSeriesError(
        RejectReason.InvalidRequest,
        "end must be after start",
      );
    const fields = (req.fields ?? "mid")
      .split(",")
      .map((f) => f.trim())
      .filter(Boolean);
    for (const f of fields)
      if (!(TIME_SERIES_FIELDS as readonly string[]).includes(f))
        throw new TimeSeriesError(
          RejectReason.InvalidRequest,
          `unknown field ${f}`,
        );
    let sub = this.#subs.get(req.subId);
    if (sub && sub.owner !== owner)
      throw new TimeSeriesError(
        RejectReason.InvalidRequest,
        `subscription ${req.subId} belongs to another user`,
      );
    if (
      sub &&
      (sub.ric !== req.ric || sub.window.fields.join() !== fields.join())
    ) {
      this.#close(sub);
      sub = undefined;
    }
    const { store } = this;
    // generates history on first use (throws for an unknown ric)
    for (const f of fields) store.series(req.ric, f as TimeSeriesField, now);
    if (!sub) {
      const ric = req.ric;
      sub = {
        subId: req.subId,
        owner,
        ric,
        window: new BucketWindow(
          fields,
          (f) => store.current(ric, f as TimeSeriesField),
          store.options.intervalMs,
        ),
        decimals: Object.fromEntries(
          fields.map((f) => [f, store.decimals(ric, f as TimeSeriesField)]),
        ),
        touched: now,
      };
      this.#subs.set(req.subId, sub);
    }
    sub.touched = now;
    const diff = sub.window.setWindow(
      {
        start: req.start,
        end: req.end,
        points: req.points,
        follow: req.follow,
      },
      now,
    );
    this.#apply(sub, diff);
    const mid = store.current(req.ric, fields[0] as TimeSeriesField);
    const { from, to } = sub.window.range;
    return {
      subId: req.subId,
      bucketMs: diff.width,
      from,
      to,
      buckets: sub.window.size,
      upserts: diff.upserts.length,
      removed: diff.removed.length,
      first: mid.first ?? 0,
      last: mid.last ?? 0,
      now,
      intervalMs: store.options.intervalMs,
      gapMs: store.gapMs,
      serverMs: round(performance.now() - t0, 3),
    };
  }

  close(subId: string, owner = "") {
    const sub = this.#subs.get(subId);
    if (!sub) return false;
    if (sub.owner !== owner)
      throw new TimeSeriesError(
        RejectReason.InvalidRequest,
        `subscription ${subId} belongs to another user`,
      );
    this.#close(sub);
    return true;
  }

  #close(sub: Subscription) {
    this.#subs.delete(sub.subId);
    for (const field of sub.window.fields)
      for (
        let b = sub.window.range.from;
        b < sub.window.range.to;
        b += sub.window.width
      )
        if (this.table.delete(timeSeriesBucketKey(sub.subId, field, b)))
          this.stats.rows--;
    this.stats.subscriptions = this.#subs.size;
  }

  /** After the store sampled: push changed buckets; drop expired subscriptions. */
  tick(now: number) {
    for (const sub of [...this.#subs.values()]) {
      if (now - sub.touched > this.leaseMs) {
        this.#close(sub);
        continue;
      }
      this.#apply(sub, sub.window.tick(now));
    }
  }

  #apply(sub: Subscription, diff: BucketDiff) {
    const { table } = this;
    for (const { field, bucket } of diff.removed) {
      if (table.delete(timeSeriesBucketKey(sub.subId, field, bucket)))
        this.stats.rows--;
    }
    const { idx } = this.#layout;
    for (const { field, value } of diff.upserts) {
      const key = timeSeriesBucketKey(sub.subId, field, value.bucket);
      const d = sub.decimals[field];
      const row: RowValue[] = this.#layout.row();
      row[idx.id] = key;
      row[idx.subId] = sub.subId;
      row[idx.ric] = sub.ric;
      row[idx.field] = field;
      row[idx.bucket] = value.bucket;
      row[idx.width] = diff.width;
      row[idx.count] = value.count;
      row[idx.firstT] = value.firstT;
      row[idx.first] = round(value.first, d);
      row[idx.minT] = value.minT;
      row[idx.min] = round(value.min, d);
      row[idx.maxT] = value.maxT;
      row[idx.max] = round(value.max, d);
      row[idx.lastT] = value.lastT;
      row[idx.last] = round(value.last, d);
      const rowIdx = table.rowIndexAtKey(key);
      if (rowIdx < 0) {
        table.insert(row);
        this.stats.rows++;
      } else table.update(rowIdx, row);
    }
    this.stats.upserts += diff.upserts.length;
    this.stats.removed += diff.removed.length;
    this.stats.subscriptions = this.#subs.size;
  }
}
