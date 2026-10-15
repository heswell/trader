/**
 * Pluggable durable store for the trading server: one write-ahead journal of
 * entries (each tagged with a stream, e.g. "exchange" / "oms") plus the latest
 * snapshot. A snapshot covers every entry up to and including `seq`; loading
 * returns the snapshot and the entries after it, in append order.
 *
 * All calls are synchronous so that an entry is handed to the OS before the
 * state change it records becomes visible to anyone (a `kill -9` loses at most
 * an entry that was never acknowledged). See docs/persistence.md.
 */
export interface StoreEntry<T = unknown> {
  /** Store-wide sequence number, strictly increasing (gaps allowed). */
  seq: number;
  /** Clock time the entry was appended. */
  ts: number;
  stream: string;
  data: T;
}

export interface StoredSnapshot {
  /** Last journal seq the snapshot includes. */
  seq: number;
  ts: number;
  /** Snapshot data per stream. */
  data: Record<string, unknown>;
}

export interface LoadResult {
  snapshot?: StoredSnapshot;
  /** Entries after the snapshot (all entries when there is no snapshot). */
  entries: StoreEntry[];
  /** Recoverable problems found while loading (e.g. a torn last journal line). */
  warnings: string[];
}

export type StoreKind = "memory" | "file" | "sqlite";

export interface PersistenceStore {
  readonly kind: StoreKind;
  /** Human-readable location, for logs. */
  readonly location: string;
  /** Read the latest snapshot and the journal after it. Call once, before append. */
  load(): LoadResult;
  /** Append one journal entry; returns its seq. */
  append(stream: string, data: unknown, ts: number): number;
  /**
   * Persist a snapshot of the state after every entry appended so far, then
   * drop the entries it covers (compaction).
   */
  snapshot(data: Record<string, unknown>, ts: number): void;
  /** Entries appended since the last snapshot (drives size-based compaction). */
  readonly entriesSinceSnapshot: number;
  /** Delete every snapshot and journal entry. */
  clear(): void;
  close(): void;
}

export interface StoreOptions {
  /**
   * fsync every journal append (and the snapshot) to the device. Default
   * false: entries reach the OS page cache synchronously, which survives a
   * process crash (kill -9) but not a power loss / kernel panic.
   */
  fsync?: boolean;
}
