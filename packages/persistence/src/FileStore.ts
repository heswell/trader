import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { acquireLock } from "./lock";
import type {
  LoadResult,
  PersistenceStore,
  StoredSnapshot,
  StoreEntry,
  StoreOptions,
} from "./types";

const SNAPSHOT = /^snapshot-(\d+)\.json$/;
const JOURNAL = /^journal-(\d+)\.ndjson$/;
export const LOCK = "LOCK";
const pad = (n: number) => String(n).padStart(12, "0");

interface JournalLine {
  seq: number;
  ts: number;
  s: string;
  d: unknown;
}

/**
 * Directory store: `snapshot-<seq>.json` (written to a temp file, fsynced and
 * renamed, so a snapshot is either complete or absent) plus append-only
 * `journal-<firstSeq>.ndjson` segments, one JSON entry per line. Each
 * snapshot starts a new segment and deletes the segments and snapshots it
 * supersedes. A `LOCK` file (pid) stops two live processes sharing a dir.
 */
export class FileStore implements PersistenceStore {
  readonly kind = "file" as const;
  readonly dir: string;
  readonly #fsync: boolean;
  #fd: number | undefined;
  #seq = 0;
  #sinceSnapshot = 0;
  #unlock: (() => void) | undefined;

  constructor(dir: string, { fsync = false }: StoreOptions = {}) {
    this.dir = resolve(dir);
    this.#fsync = fsync;
    mkdirSync(this.dir, { recursive: true });
    this.#unlock = acquireLock(join(this.dir, LOCK), `dir ${this.dir}`);
  }

  get location() {
    return this.dir;
  }

  #files(pattern: RegExp) {
    return readdirSync(this.dir)
      .map((name) => {
        const match = pattern.exec(name);
        return match ? { name, n: Number(match[1]) } : undefined;
      })
      .filter((f): f is { name: string; n: number } => f !== undefined)
      .sort((a, b) => a.n - b.n);
  }

  load(): LoadResult {
    const warnings: string[] = [];
    let snapshot: StoredSnapshot | undefined;
    for (const { name } of this.#files(SNAPSHOT).reverse()) {
      try {
        const parsed = JSON.parse(readFileSync(join(this.dir, name), "utf8"));
        snapshot = { seq: parsed.seq, ts: parsed.ts, data: parsed.data };
        break;
      } catch (err) {
        warnings.push(`unreadable snapshot ${name}: ${(err as Error).message}`);
      }
    }
    const after = snapshot?.seq ?? 0;
    const entries: StoreEntry[] = [];
    let last = after;
    for (const { name } of this.#files(JOURNAL)) {
      const path = join(this.dir, name);
      const lines = readFileSync(path, "utf8").split("\n");
      while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
      lines.forEach((text, i) => {
        let line: JournalLine;
        try {
          line = JSON.parse(text);
        } catch {
          if (i === lines.length - 1) {
            // A write cut short by a crash: drop it so later appends start clean.
            warnings.push(
              `${name}: dropped torn last line (${text.length} bytes)`,
            );
            const good = lines.slice(0, i);
            writeFileSync(path, good.length ? `${good.join("\n")}\n` : "");
            return;
          }
          throw Error(`${name}:${i + 1}: corrupt journal entry`);
        }
        if (line.seq <= last) return;
        last = line.seq;
        entries.push({
          seq: line.seq,
          ts: line.ts,
          stream: line.s,
          data: line.d,
        });
      });
    }
    this.#seq = last;
    this.#sinceSnapshot = entries.length;
    return { snapshot, entries, warnings };
  }

  append(stream: string, data: unknown, ts: number) {
    const seq = ++this.#seq;
    if (this.#fd === undefined) {
      this.#fd = openSync(join(this.dir, `journal-${pad(seq)}.ndjson`), "a");
    }
    const line: JournalLine = { seq, ts, s: stream, d: data };
    const bytes = Buffer.from(`${JSON.stringify(line)}\n`);
    let written = 0;
    while (written < bytes.length) {
      written += writeSync(this.#fd, bytes, written);
    }
    if (this.#fsync) fsyncSync(this.#fd);
    this.#sinceSnapshot++;
    return seq;
  }

  snapshot(data: Record<string, unknown>, ts: number) {
    const seq = this.#seq;
    const name = `snapshot-${pad(seq)}.json`;
    const tmp = join(this.dir, `${name}.tmp`);
    const fd = openSync(tmp, "w");
    try {
      writeSync(fd, JSON.stringify({ format: 1, seq, ts, data }));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, join(this.dir, name));
    this.#syncDir();
    this.#closeSegment();
    for (const file of this.#files(JOURNAL)) {
      rmSync(join(this.dir, file.name), { force: true });
    }
    for (const file of this.#files(SNAPSHOT)) {
      if (file.n < seq) rmSync(join(this.dir, file.name), { force: true });
    }
    this.#sinceSnapshot = 0;
  }

  #syncDir() {
    try {
      const fd = openSync(this.dir, "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch {
      // Not supported on every platform; the rename is still atomic.
    }
  }

  #closeSegment() {
    if (this.#fd !== undefined) closeSync(this.#fd);
    this.#fd = undefined;
  }

  get entriesSinceSnapshot() {
    return this.#sinceSnapshot;
  }

  clear() {
    this.#closeSegment();
    if (existsSync(this.dir)) {
      for (const name of readdirSync(this.dir)) {
        if (SNAPSHOT.test(name) || JOURNAL.test(name) || name.endsWith(".tmp"))
          rmSync(join(this.dir, name), { force: true });
      }
    }
    this.#seq = 0;
    this.#sinceSnapshot = 0;
  }

  close() {
    this.#closeSegment();
    this.#unlock?.();
    this.#unlock = undefined;
  }
}
