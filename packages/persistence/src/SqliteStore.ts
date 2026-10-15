import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { acquireLock } from "./lock";
import type {
  LoadResult,
  PersistenceStore,
  StoreEntry,
  StoreOptions,
} from "./types";

interface JournalRow {
  seq: number;
  ts: number;
  stream: string;
  data: string;
}

/**
 * SQLite store (bun:sqlite, WAL mode): a `journal` table of entries and a
 * single-row `snapshot` table. A snapshot replaces the row and deletes the
 * entries it covers in one transaction. `fsync` maps to
 * `PRAGMA synchronous=FULL` (else NORMAL: durable across a process crash,
 * the last transactions may be lost on power failure).
 */
export class SqliteStore implements PersistenceStore {
  readonly kind = "sqlite" as const;
  readonly location: string;
  readonly #db: Database;
  readonly #insert;
  #seq = 0;
  #sinceSnapshot = 0;
  #unlock: (() => void) | undefined;

  constructor(file: string, { fsync = false }: StoreOptions = {}) {
    this.location = file === ":memory:" ? file : resolve(file);
    if (file !== ":memory:") {
      mkdirSync(dirname(this.location), { recursive: true });
      this.#unlock = acquireLock(
        `${this.location}.lock`,
        `database ${this.location}`,
      );
    }
    const db = new Database(this.location, { create: true, strict: true });
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(`PRAGMA synchronous = ${fsync ? "FULL" : "NORMAL"}`);
    db.exec(
      "CREATE TABLE IF NOT EXISTS journal (seq INTEGER PRIMARY KEY, ts INTEGER NOT NULL, stream TEXT NOT NULL, data TEXT NOT NULL)",
    );
    db.exec(
      "CREATE TABLE IF NOT EXISTS snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), seq INTEGER NOT NULL, ts INTEGER NOT NULL, data TEXT NOT NULL)",
    );
    this.#db = db;
    this.#insert = db.prepare(
      "INSERT INTO journal (seq, ts, stream, data) VALUES ($seq, $ts, $stream, $data)",
    );
  }

  load(): LoadResult {
    const row = this.#db
      .query("SELECT seq, ts, data FROM snapshot WHERE id = 1")
      .get() as { seq: number; ts: number; data: string } | null;
    const snapshot = row
      ? { seq: row.seq, ts: row.ts, data: JSON.parse(row.data) }
      : undefined;
    const after = snapshot?.seq ?? 0;
    const rows = this.#db
      .query(
        "SELECT seq, ts, stream, data FROM journal WHERE seq > $after ORDER BY seq",
      )
      .all({ after }) as JournalRow[];
    const entries: StoreEntry[] = rows.map((r) => ({
      seq: r.seq,
      ts: r.ts,
      stream: r.stream,
      data: JSON.parse(r.data),
    }));
    this.#seq = entries.length ? entries[entries.length - 1].seq : after;
    this.#sinceSnapshot = entries.length;
    return { snapshot, entries, warnings: [] };
  }

  append(stream: string, data: unknown, ts: number) {
    const seq = ++this.#seq;
    this.#insert.run({ seq, ts, stream, data: JSON.stringify(data) });
    this.#sinceSnapshot++;
    return seq;
  }

  snapshot(data: Record<string, unknown>, ts: number) {
    const seq = this.#seq;
    const json = JSON.stringify(data);
    this.#db.transaction(() => {
      this.#db
        .query(
          "INSERT OR REPLACE INTO snapshot (id, seq, ts, data) VALUES (1, $seq, $ts, $data)",
        )
        .run({ seq, ts, data: json });
      this.#db.query("DELETE FROM journal WHERE seq <= $seq").run({ seq });
    })();
    this.#sinceSnapshot = 0;
  }

  get entriesSinceSnapshot() {
    return this.#sinceSnapshot;
  }

  clear() {
    this.#db.transaction(() => {
      this.#db.exec("DELETE FROM journal");
      this.#db.exec("DELETE FROM snapshot");
    })();
    this.#seq = 0;
    this.#sinceSnapshot = 0;
  }

  close() {
    this.#db.close();
    this.#unlock?.();
    this.#unlock = undefined;
  }
}
