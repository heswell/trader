import type {
  LoadResult,
  PersistenceStore,
  StoredSnapshot,
  StoreEntry,
} from "./types";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/**
 * In-process store, the default for tests: survives re-instantiating the
 * simulator / OMS from the same store object, not a process restart. Entries
 * are JSON round-tripped so restore sees exactly what a durable store would.
 */
export class MemoryStore implements PersistenceStore {
  readonly kind = "memory" as const;
  readonly location = "memory";
  #snapshot: StoredSnapshot | undefined;
  #entries: StoreEntry[] = [];
  #seq = 0;

  load(): LoadResult {
    const snapshot = this.#snapshot ? clone(this.#snapshot) : undefined;
    return { snapshot, entries: clone(this.#entries), warnings: [] };
  }

  append(stream: string, data: unknown, ts: number) {
    const seq = ++this.#seq;
    this.#entries.push({ seq, ts, stream, data: clone(data) });
    return seq;
  }

  snapshot(data: Record<string, unknown>, ts: number) {
    this.#snapshot = { seq: this.#seq, ts, data: clone(data) };
    this.#entries = [];
  }

  get entriesSinceSnapshot() {
    return this.#entries.length;
  }

  clear() {
    this.#snapshot = undefined;
    this.#entries = [];
  }

  close() {}
}
